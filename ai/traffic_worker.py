"""Offline NanoDet-Plus traffic sampler for authorized local video clips.

This worker never opens network streams, saves frames, or writes video. Its
output is an aggregate estimate only; it does not identify unique vehicles.

NanoDet output decoding follows the OpenCV Zoo NanoDet implementation:
https://github.com/opencv/opencv_zoo/tree/main/models/object_detection_nanodet
Copyright (C) OpenCV contributors; distributed under Apache-2.0.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DEFAULT = Path(__file__).resolve().parent / "traffic-estimates.json"
INPUT_SIZE = 416
STRIDES = (8, 16, 32, 64)
REG_MAX = 7
VEHICLE_CLASSES = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
EXPECTED_MODEL_SHA256 = "8dd32b85f2d273e9047f1d6b59e0b2fd008b1076338107bb547ac28942cdf90b"
VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"}
SAFE_ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")


class WorkerError(Exception):
    """An actionable input or inference error for the CLI user."""


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def reject_url(raw: str, label: str) -> None:
    lowered = raw.strip().lower()
    if "://" in lowered or lowered.startswith(("rtsp:", "rtmp:", "http:", "https:", "file:")):
        raise WorkerError(f"{label} must be a local filesystem path, not a URL or stream.")


def local_external_file(raw: str, label: str, suffixes: set[str] | None = None) -> Path:
    reject_url(raw, label)
    try:
        path = Path(raw).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise WorkerError(f"{label} does not exist or cannot be resolved: {raw}") from exc

    if not path.is_file():
        raise WorkerError(f"{label} must point to a file.")
    if is_within(path, PROJECT_ROOT):
        raise WorkerError(
            f"Keep {label.lower()} outside the project folder because the local web server serves project files."
        )
    if suffixes and path.suffix.lower() not in suffixes:
        choices = ", ".join(sorted(suffixes))
        raise WorkerError(f"Unsupported {label.lower()} extension {path.suffix!r}; use one of: {choices}.")
    return path


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def letterbox_rgb(frame_bgr: Any, cv2: Any) -> Any:
    """Match OpenCV Zoo's 416x416 RGB letterbox preprocessing."""
    height, width = frame_bgr.shape[:2]
    if height <= 0 or width <= 0:
        raise WorkerError("Decoded video frame has invalid dimensions.")

    if height > width:
        new_height = INPUT_SIZE
        new_width = int(INPUT_SIZE / (height / width))
        left = int((INPUT_SIZE - new_width) * 0.5)
        top = 0
    elif width > height:
        new_width = INPUT_SIZE
        new_height = int(INPUT_SIZE * (height / width))
        top = int((INPUT_SIZE - new_height) * 0.5)
        left = 0
    else:
        new_height = new_width = INPUT_SIZE
        top = left = 0

    resized = cv2.resize(frame_bgr, (new_width, new_height), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
    return cv2.copyMakeBorder(
        rgb,
        top,
        INPUT_SIZE - new_height - top,
        left,
        INPUT_SIZE - new_width - left,
        cv2.BORDER_CONSTANT,
        value=(0, 0, 0),
    )


class NanoDetPlus:
    """Minimal CPU-only OpenCV DNN adapter for OpenCV Zoo NanoDet-Plus ONNX."""

    def __init__(self, model_path: Path, cv2: Any, numpy: Any, score_threshold: float, nms_threshold: float):
        self.cv2 = cv2
        self.np = numpy
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        try:
            self.net = cv2.dnn.readNet(str(model_path))
            self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            self.output_names = self.net.getUnconnectedOutLayersNames()
        except Exception as exc:  # OpenCV uses several exception classes across builds.
            raise WorkerError(f"OpenCV could not load the ONNX model: {exc}") from exc
        if not self.output_names or len(self.output_names) != len(STRIDES) * 2:
            raise WorkerError(
                "Model outputs do not match the OpenCV Zoo NanoDet-Plus 416 ONNX layout."
            )

        self.anchors: list[Any] = []
        for stride in STRIDES:
            feat_h = INPUT_SIZE // stride
            feat_w = INPUT_SIZE // stride
            shift_x, shift_y = numpy.meshgrid(
                numpy.arange(feat_w, dtype=numpy.float32) * stride,
                numpy.arange(feat_h, dtype=numpy.float32) * stride,
            )
            center_x = shift_x.reshape(-1) + 0.5 * (stride - 1)
            center_y = shift_y.reshape(-1) + 0.5 * (stride - 1)
            self.anchors.append(numpy.column_stack((center_x, center_y)))

    def detect(self, frame_bgr: Any) -> list[tuple[int, float]]:
        np = self.np
        rgb = letterbox_rgb(frame_bgr, self.cv2).astype(np.float32)
        mean = np.array([103.53, 116.28, 123.675], dtype=np.float32).reshape(1, 1, 3)
        std = np.array([57.375, 57.12, 58.395], dtype=np.float32).reshape(1, 1, 3)
        normalized = (rgb - mean) / std
        blob = self.cv2.dnn.blobFromImage(normalized)

        try:
            self.net.setInput(blob)
            outputs = self.net.forward(self.output_names)
        except Exception as exc:
            raise WorkerError(f"OpenCV DNN inference failed: {exc}") from exc

        boxes_all: list[Any] = []
        scores_all: list[Any] = []
        classes_all: list[Any] = []
        for layer, stride, anchors in zip(range(0, len(outputs), 2), STRIDES, self.anchors):
            scores = np.asarray(outputs[layer])
            distances = np.asarray(outputs[layer + 1])
            if scores.ndim == 3 and scores.shape[0] == 1:
                scores = scores[0]
            if distances.ndim == 3 and distances.shape[0] == 1:
                distances = distances[0]
            if scores.ndim != 2 or distances.ndim != 2:
                raise WorkerError("Unexpected tensor shape from NanoDet-Plus model output.")

            anchors_at_level = anchors
            if scores.shape[0] != anchors.shape[0] or distances.shape[0] != anchors.shape[0]:
                raise WorkerError("NanoDet output dimensions do not match its 416px anchor grid.")
            if distances.shape[1] != (REG_MAX + 1) * 4:
                raise WorkerError("NanoDet box regression output must have 32 values per anchor.")

            keep = min(1000, scores.shape[0])
            top_indices = np.argpartition(scores.max(axis=1), -keep)[-keep:]
            scores = scores[top_indices]
            anchors_at_level = anchors_at_level[top_indices]
            distances = distances[top_indices].reshape(-1, 4, REG_MAX + 1)

            # Stable softmax, equivalent to the upstream DFL expectation decode.
            distances = distances - distances.max(axis=2, keepdims=True)
            probabilities = np.exp(distances)
            probabilities /= probabilities.sum(axis=2, keepdims=True)
            expectation = np.sum(probabilities * np.arange(REG_MAX + 1, dtype=np.float32), axis=2)
            expectation *= stride

            x1 = np.clip(anchors_at_level[:, 0] - expectation[:, 0], 0, INPUT_SIZE)
            y1 = np.clip(anchors_at_level[:, 1] - expectation[:, 1], 0, INPUT_SIZE)
            x2 = np.clip(anchors_at_level[:, 0] + expectation[:, 2], 0, INPUT_SIZE)
            y2 = np.clip(anchors_at_level[:, 1] + expectation[:, 3], 0, INPUT_SIZE)
            boxes_all.append(np.column_stack((x1, y1, x2, y2)))
            scores_all.append(scores)

        boxes = np.concatenate(boxes_all, axis=0)
        scores = np.concatenate(scores_all, axis=0)
        class_ids = scores.argmax(axis=1)
        confidences = scores.max(axis=1)
        boxes_xywh = boxes.copy()
        boxes_xywh[:, 2:4] -= boxes_xywh[:, 0:2]

        candidates = np.flatnonzero(
            (confidences >= self.score_threshold) & np.isin(class_ids, list(VEHICLE_CLASSES))
        )
        if candidates.size == 0:
            return []

        # NMS must remain class-aware: overlapping cars and motorcycles are
        # separate objects, not duplicates of one another.
        kept_candidates: list[int] = []
        for class_id in np.unique(class_ids[candidates]):
            class_candidates = candidates[class_ids[candidates] == class_id]
            local_indices = self.cv2.dnn.NMSBoxes(
                boxes_xywh[class_candidates].tolist(),
                confidences[class_candidates].astype(float).tolist(),
                self.score_threshold,
                self.nms_threshold,
            )
            if local_indices is not None and len(local_indices) > 0:
                local_indices = np.asarray(local_indices).reshape(-1)
                kept_candidates.extend(class_candidates[local_indices].tolist())

        detections: list[tuple[int, float]] = []
        for index in kept_candidates:
            index = int(index)
            class_id = int(class_ids[index])
            detections.append((class_id, float(confidences[index])))
        return detections


def analyze_video(
    video_path: Path,
    model_path: Path,
    interval_seconds: float,
    max_samples: int,
    score_threshold: float,
    nms_threshold: float,
) -> tuple[dict[str, float], int, float]:
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise WorkerError("Missing Python packages. Install ai/requirements.txt in a virtual environment.") from exc

    try:
        model = NanoDetPlus(model_path, cv2, np, score_threshold, nms_threshold)
    except WorkerError:
        raise

    capture = cv2.VideoCapture(str(video_path), cv2.CAP_FFMPEG)
    if not capture.isOpened():
        capture.release()
        raise WorkerError("OpenCV could not open this video. Check its codec and file permissions.")

    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(fps) or fps <= 0:
        capture.release()
        raise WorkerError("Video has no usable FPS metadata, so a reliable sampling interval cannot be applied.")
    frame_step = max(1, int(round(fps * interval_seconds)))
    counts = {name: 0 for name in VEHICLE_CLASSES.values()}
    confidence_sum = 0.0
    confidence_count = 0
    samples = 0
    frame_index = 0

    try:
        while samples < max_samples:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % frame_step == 0:
                detections = model.detect(frame)
                for class_id, confidence in detections:
                    counts[VEHICLE_CLASSES[class_id]] += 1
                    confidence_sum += confidence
                    confidence_count += 1
                samples += 1
            frame_index += 1
    finally:
        capture.release()

    if samples == 0:
        raise WorkerError("No decodable video frames were sampled.")

    means = {name: round(count / samples, 3) for name, count in counts.items()}
    mean_confidence = round(confidence_sum / confidence_count, 4) if confidence_count else None
    return means, samples, mean_confidence


def write_json_safely(path: Path, payload: dict[str, Any], protected_paths: set[Path]) -> None:
    expanded = path.expanduser()
    if expanded.is_symlink():
        raise WorkerError("Output path must not be a symlink.")
    resolved = expanded.resolve()
    if resolved in protected_paths:
        raise WorkerError("Output path must not overwrite the input video or ONNX model.")
    if resolved.suffix.lower() != ".json":
        raise WorkerError("Output file must use the .json extension.")
    if is_within(resolved, PROJECT_ROOT) and resolved != OUTPUT_DEFAULT.resolve():
        raise WorkerError(
            f"Inside the project, output is restricted to {OUTPUT_DEFAULT.relative_to(PROJECT_ROOT)}."
        )
    if not resolved.parent.is_dir():
        raise WorkerError("Output folder does not exist. Create it first or choose an existing folder.")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=resolved.parent,
            prefix=f".{resolved.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_path, resolved)
    except OSError as exc:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise WorkerError(f"Could not write JSON output: {exc}") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Estimate aggregate vehicle counts from one authorized local video file using CPU inference."
    )
    parser.add_argument("--input", required=True, help="Local video path; HTTP/RTSP URLs are rejected.")
    parser.add_argument(
        "--model",
        required=True,
        help="Path to an externally stored OpenCV Zoo NanoDet-Plus 416 INT8 ONNX model.",
    )
    parser.add_argument(
        "--output",
        default=str(OUTPUT_DEFAULT),
        help=f"JSON output path (default: {OUTPUT_DEFAULT}).",
    )
    parser.add_argument("--interval-seconds", type=float, default=2.0, help="Time between sampled frames (default: 2).")
    parser.add_argument("--max-samples", type=int, default=120, help="Maximum frames to infer (default: 120).")
    parser.add_argument("--score-threshold", type=float, default=0.35, help="Detection score threshold (default: 0.35).")
    parser.add_argument("--nms-threshold", type=float, default=0.60, help="NMS IoU threshold (default: 0.60).")
    parser.add_argument(
        "--camera-id",
        help="Optional catalog ID, only for a clip whose source-to-camera mapping has been reviewed.",
    )
    parser.add_argument(
        "--mapping-provenance",
        help="Short note describing how the local clip was verified as belonging to --camera-id.",
    )
    parser.add_argument(
        "--confirm-camera-mapping",
        action="store_true",
        help="Required with --camera-id to mark the mapping as deliberate and reviewed.",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if not math.isfinite(args.interval_seconds) or args.interval_seconds <= 0:
            raise WorkerError("--interval-seconds must be a positive finite number.")
        if args.max_samples < 1 or args.max_samples > 1000:
            raise WorkerError("--max-samples must be between 1 and 1000.")
        if not 0 <= args.score_threshold <= 1 or not 0 <= args.nms_threshold <= 1:
            raise WorkerError("Detection and NMS thresholds must be between 0 and 1.")

        if args.camera_id:
            if not SAFE_ID.fullmatch(args.camera_id):
                raise WorkerError("--camera-id may contain only letters, numbers, underscores, and hyphens.")
            if not args.confirm_camera_mapping:
                raise WorkerError("--camera-id requires --confirm-camera-mapping after source mapping review.")
            if not args.mapping_provenance or not args.mapping_provenance.strip():
                raise WorkerError("--camera-id also requires a non-empty --mapping-provenance note.")
        elif args.confirm_camera_mapping or args.mapping_provenance:
            raise WorkerError("--confirm-camera-mapping and --mapping-provenance require --camera-id.")

        video_path = local_external_file(args.input, "Input video", VIDEO_EXTENSIONS)
        model_path = local_external_file(args.model, "ONNX model", {".onnx"})
        model_sha256 = sha256_file(model_path)
        if model_sha256.lower() != EXPECTED_MODEL_SHA256:
            raise WorkerError(
                "Unsupported ONNX model. Use the OpenCV Zoo object_detection_nanodet_2022nov_int8.onnx file; its SHA-256 must match the documented official artifact."
            )
        counts_mean, sample_count, mean_confidence = analyze_video(
            video_path,
            model_path,
            args.interval_seconds,
            args.max_samples,
            args.score_threshold,
            args.nms_threshold,
        )
        model_version = model_path.stem
        payload = {
            "schema_version": 1,
            "generated_at": utc_now(),
            "model": {
                "name": "NanoDet-Plus 1.5x 416",
                "format": "ONNX",
                "precision": "INT8",
                "input_size": [INPUT_SIZE, INPUT_SIZE],
                "version": model_version,
                "sha256": model_sha256,
            },
            "estimates": [
                {
                    "source_id": "sample-demo",
                    "camera_id": args.camera_id if args.camera_id else None,
                    "source_type": "local-video",
                    "clip_interval_seconds": args.interval_seconds,
                    "sample_count": sample_count,
                    "vehicle_counts_mean_per_frame": counts_mean,
                    "mean_detection_confidence": mean_confidence,
                    "estimated_density": None,
                    "mapping_is_explicit": bool(args.camera_id),
                    "mapping_provenance": args.mapping_provenance.strip() if args.mapping_provenance else None,
                }
            ],
        }
        output_path = Path(args.output).expanduser()
        write_json_safely(output_path, payload, {video_path, model_path})
        print(f"Wrote aggregate estimate to {output_path.resolve()}")
        print(f"Sampled {sample_count} frames; no frames or video were saved.")
        return 0
    except WorkerError as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
