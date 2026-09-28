# Offline traffic estimate worker

This prototype samples one **authorized local video file**, runs OpenCV DNN on the CPU with the OpenCV Zoo NanoDet-Plus 1.5x 416 INT8 ONNX model, then writes aggregate counts to `ai/traffic-estimates.json`.

It does not open URLs, connect to Bali Tower, save frames, record video, track identities, or identify unique vehicles. Keep both the sample video and ONNX weights **outside this project folder**: the local web server serves project files.

## Requirements

- Python 3.10–3.12, 64-bit
- Headless OpenCV Python 4.10 or newer and NumPy, listed in `requirements.txt`
- Git LFS for obtaining the ONNX model from OpenCV Zoo
- An authorized local `.mp4`, `.mkv`, `.avi`, `.mov`, `.m4v`, `.mpeg`, `.mpg`, or `.webm` clip

The worker uses CPU inference only. It needs no PyTorch, CUDA, model training, or live stream credentials. The model is not bundled or downloaded automatically. Before processing a clip, the worker verifies the model file against the official OpenCV Zoo INT8 artifact SHA-256 (`8dd32b85f2d273e9047f1d6b59e0b2fd008b1076338107bb547ac28942cdf90b`); other ONNX files are rejected.

## Setup on Windows

Run these commands from the project folder. The virtual environment, videos, and model weights all stay outside the project folder.

```powershell
$AiVenv = Join-Path $env:LOCALAPPDATA "RuangPantauAI\venv"
py -3.12 -m venv $AiVenv
& "$AiVenv\Scripts\python.exe" -m pip install -r ai\requirements.txt
```

Install Git LFS if needed, then fetch the official OpenCV Zoo model to a user-data directory outside the project:

```powershell
git lfs install
$ZooPath = Join-Path $env:LOCALAPPDATA "RuangPantauAI\opencv_zoo"
$env:GIT_LFS_SKIP_SMUDGE = "1"
git clone https://github.com/opencv/opencv_zoo.git $ZooPath
Remove-Item Env:GIT_LFS_SKIP_SMUDGE
git -C $ZooPath lfs pull --include="models/object_detection_nanodet/object_detection_nanodet_2022nov_int8.onnx"
```

If the repository already exists at `$ZooPath`, skip `git clone` and run only the `git -C ... lfs pull` command. The clone and weights stay under `%LOCALAPPDATA%`, not in the web-served project. Check the OpenCV Zoo model README and applicable model/data terms before use; permission to use the model does not grant permission to process a video.

## Run an offline sample

Choose a local video that you are authorized to analyze and keep it outside the project directory. The worker reads it without writing image or video files:

```powershell
$AiPython = Join-Path $env:LOCALAPPDATA "RuangPantauAI\venv\Scripts\python.exe"
& $AiPython ai\traffic_worker.py `
  --input "C:\Users\you\Videos\authorized-traffic-sample.mp4" `
  --model "$ZooPath\models\object_detection_nanodet\object_detection_nanodet_2022nov_int8.onnx"
```

Defaults are one inference every 2 seconds, up to 120 sampled frames, score threshold `0.35`, NMS threshold `0.60`, and output `ai/traffic-estimates.json`. The safety limit is 1,000 sampled frames per run. Adjust sampling if needed:

```powershell
& $AiPython ai\traffic_worker.py `
  --input "D:\authorized-samples\clip.mp4" `
  --model "$ZooPath\models\object_detection_nanodet\object_detection_nanodet_2022nov_int8.onnx" `
  --interval-seconds 3 --max-samples 40
```

HTTP/RTSP/RTMP/file URLs are rejected. The input must be a supported video file with usable FPS metadata; unreadable codecs or missing FPS stop the run rather than silently changing the interval. The model and video paths are resolved before opening to catch symlinks into the project folder.

## Camera mapping

By default, the output uses `source_id: "sample-demo"`, `camera_id: null`, and `mapping_is_explicit: false`. This prevents an arbitrary sample from appearing to be a real CCTV feed. `estimated_density` stays `null`: the worker has no camera-specific road ROI or validated density thresholds, and raw counts alone do not establish congestion.

Only map a sample to a catalog camera if its source mapping has been reviewed and documented. The CLI requires all three options together:

```powershell
--camera-id menteng_01 `
--confirm-camera-mapping `
--mapping-provenance "Authorized local export matched to catalog camera menteng_01"
```

This is a provenance annotation supplied by the operator; the worker cannot independently verify it. The frontend should still describe values as offline estimates, never as the current live feed.

## Output and interpretation

The JSON contains:

- model name, format, precision, input dimensions, file-version label, and SHA-256
- sample count and interval
- mean per-frame detections for cars, motorcycles, buses, and trucks
- average raw detection score, which is not a calibrated probability
- optional explicit camera mapping provenance

Counts are **average detected objects per sampled frame**, rounded to three decimal places. They are not unique-vehicle counts across the clip. `mean_detection_confidence` averages raw model scores over vehicle detections; it is `0` when none were detected. This is a baseline for review, not a verified traffic measurement. Assess accuracy against labeled clips before relying on it.

The sampling interval is nominal: the worker uses the clip's reported average FPS to choose frame indices, so variable-frame-rate clips may not match the requested wall-clock spacing. Prefer fixed-frame-rate clips for this prototype. The worker writes the JSON atomically and does not put the absolute video path or frame data in the output. If no vehicles are detected, the mean detection score is `null` rather than `0`. A missing or unsupported model, unavailable codec, or unreadable video produces a clear CLI error; there is no placeholder estimate.

## Model and source attribution

The NanoDet output decoder is adapted from the [OpenCV Zoo NanoDet implementation](https://github.com/opencv/opencv_zoo/tree/main/models/object_detection_nanodet), whose repository code is under Apache-2.0. See `NOTICE.md` for attribution. The worker accepts only the official INT8 artifact with the pinned [OpenCV Zoo model-file digest](https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/object_detection_nanodet/object_detection_nanodet_2022nov_int8.onnx). Review the repository's current model card, code and model terms before distributing or deploying it. The software license does not provide rights to any CCTV feed, sample clip, or dataset.
