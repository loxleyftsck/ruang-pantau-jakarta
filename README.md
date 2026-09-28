# Ruang Pantau — CCTV Jakarta

Ruang Pantau Jakarta adalah prototype web dengan landing page di `/` dan dashboard peta di `/dashboard.html`. Pengguna dapat mencari titik kamera dari katalog `cameras.json`, melihatnya di peta, dan mencoba membuka feed pihak ketiga jika feed tersebut dapat diputar. Aplikasi tidak memiliki backend, API kamera terpadu, pemantauan kesehatan provider yang persisten, atau proses perekaman video.

## Menjalankan secara lokal

Perlu Node.js 18+ untuk menjalankan server statis tanpa memasang dependensi tambahan. Buka PowerShell di folder proyek, lalu jalankan:

```sh
node serve.js
```

Buka landing page di <http://127.0.0.1:8000/> dan dashboard peta di <http://127.0.0.1:8000/dashboard.html>. Hentikan server dengan `Ctrl+C`. Jika port 8000 sedang dipakai, atur `$env:PORT=8080` di PowerShell sebelum menjalankan `node serve.js`, lalu gunakan port 8080.

Jalankan melalui HTTP lokal, bukan dengan membuka HTML sebagai `file://`. Pemuatan katalog kamera, HLS, dan kebijakan origin browser dapat gagal pada skema `file://`.

## Analisis AI ringan (MVP offline)

Dashboard dapat menampilkan estimasi kendaraan dari klip lokal melalui worker Python terpisah. Worker memakai NanoDet-Plus INT8 dan OpenCV DNN di CPU; server Node tetap hanya menyajikan file statis dan tidak menjalankan analisis atau mengakses feed live. Lihat [panduan worker](ai/README.md) untuk menyiapkan Python, mengambil model ke luar folder proyek, dan menjalankan analisis.

Hasil agregat ditulis ke `ai/traffic-estimates.json`. Buka ulang atau muat ulang dashboard untuk membacanya. Secara default hasil adalah sampel demo yang tidak dipetakan ke kamera. Hanya pemetaan yang dikonfirmasi operator dan disertai provenance yang bisa muncul pada kamera tertentu. Nilai hitungan adalah rata-rata deteksi per frame; interval sampling bersifat nominal berdasarkan metadata FPS; kepadatan tetap belum dinilai sampai ROI dan ambang batas dikalibrasi. Worker tidak menerima URL CCTV dan tidak menganalisis siaran Bali Tower.

Video dan model harus disimpan di luar folder proyek karena server lokal menyajikan semua file dalam folder ini. Untuk batasan model, perizinan klip, interpretasi hasil, dan petunjuk lengkap, baca [ai/README.md](ai/README.md).

## Dependensi jaringan

Aplikasi tidak membundel pustaka atau peta secara lokal. Koneksi internet dibutuhkan untuk:

- Leaflet 1.9.4 CSS dan JavaScript dari `unpkg.com`.
- MapLibre GL CSS dan JavaScript versi mayor 5, serta adaptor Leaflet dari `unpkg.com`.
- hls.js 1.7.3 dari `cdn.jsdelivr.net` untuk pemutaran HLS di browser yang tidak mendukung HLS secara native.
- Style dan tile basemap dari `tiles.openfreemap.org`.
- Halaman embed, manifest, serta segmen video dari host feed kamera, saat kamera dipilih.

Pemblokir konten, kegagalan CDN, CORS, aturan embed dari penyedia, perubahan URL, atau gangguan jaringan dapat mencegah sebagian fitur dimuat. Peta menggunakan style publik OpenFreeMap dengan data OpenStreetMap; layanan publik dapat berubah dan tidak menyediakan jaminan ketersediaan untuk aplikasi ini. Aplikasi menampilkan atribusi peta otomatis.

## Menambahkan atau memperbarui kamera

Edit array kamera di `cameras.json`. Setiap entri memakai skema berikut:

```json
[
  {
    "id": "contoh-kamera-1",
    "name": "Contoh Lokasi",
    "view": "CCTV 01",
    "area": "Jakarta Selatan",
    "district": "Kebayoran Baru",
    "lat": -6.2255,
    "lng": 106.8003,
    "url": "https://cctv.balitower.co.id/contoh/embed.html",
    "provider": "Bali Tower",
    "feedType": "hls-derived"
  }
]
```

`id` harus unik dan stabil karena digunakan untuk marker, pilihan kamera, dan favorit. `name`, `view`, `area`, `district`, `lat`, `lng`, dan `url` menjelaskan lokasi serta sumber feed. `provider` adalah nama penyedia feed, sedangkan `feedType` menjelaskan cara aplikasi mencoba memutarnya; nilai `hls-derived` berarti aplikasi membentuk URL manifest HLS dari URL embed Bali Tower. Jangan simpan status siaran dinamis di katalog.

Pastikan `url` adalah URL absolut HTTPS, nama wilayah cocok dengan label filter, dan koordinatnya benar sebelum menyimpan. Koordinat katalog saat ini bersifat perkiraan; verifikasi setiap titik di peta. Setelah menambahkan wilayah baru, periksa juga tombol filter di `index.html` karena daftar wilayah filter ditulis terpisah dari katalog.

## Cara pemutar memilih sumber

- Untuk URL pada host persis `cctv.balitower.co.id`, aplikasi menambahkan `proto=hls` ke URL sumber bila parameter itu belum ada. Pemutar kemudian membentuk URL manifest dengan mengganti akhiran `/embed.html` menjadi `/index.fmp4.m3u8`.
- Manifest Bali Tower diputar memakai hls.js jika tersedia, atau pemutar HLS native browser (misalnya Safari) sebagai fallback. Autoplay dapat ditolak browser; video dibuat muted dan kontrol putar tersedia.
- Host lain dibuka sebagai halaman di dalam `iframe`. Aplikasi tidak mengonversi URL pihak lain menjadi HLS dan tidak dapat melewati larangan embed, autentikasi, CORS, atau pembatasan akses penyedia.
- Setiap sesi pemutar dimulai dengan status belum diverifikasi/menghubungkan. Status `LIVE · TERHUBUNG` hanya muncul setelah elemen video memancarkan event `playing`; ini berarti video mulai berjalan pada sesi tersebut, bukan pemeriksaan kesehatan provider secara umum.
- Status koneksi, buffering, terputus, atau gagal adalah status sesi di browser untuk kamera yang sedang dipilih. Status tersebut tidak disimpan ke `cameras.json` dan tidak mewakili riwayat maupun kesehatan semua feed dari provider. Aplikasi tidak menjalankan probe terjadwal atau menyimpan hasil pemeriksaan provider.
- Filter **Terputar sesi ini**, **Belum dicek**, dan **Gagal sesi ini** memfilter berdasarkan hasil pemutaran selama tab masih terbuka. Label terputar berarti video pernah berjalan pada sesi tab ini; kegagalan hanya mencatat percobaan pemutaran di sesi, bukan status provider. Semua kamera kembali berstatus belum diverifikasi saat halaman dimuat ulang.
- Tombol besarkan pemutar meminta mode layar penuh browser; jika tidak tersedia atau ditolak, player diperbesar di dalam area peta. `Escape` keluar dari tampilan besar sebelum menutup panel.
- Tautan **Buka sumber asli** membuka URL embed kamera. Tombol **Portal CCTV resmi** menuju <https://jakcctv.jakarta.go.id/publik>.

Daftar URL Bali Tower dalam katalog adalah tautan publik pihak ketiga. Keberadaan URL tersebut tidak berarti tersedia API publik resmi atau integrasi API CCTV yang terdokumentasi. Tidak ada jaminan semua URL aktif, HLS tersedia, atau boleh digunakan ulang. Feed dapat mati, berubah, membatasi embed, atau berhenti tanpa pemberitahuan. Periksa izin, syarat penggunaan, dan kebijakan penyedia sebelum distribusi atau penggunaan operasional. Aplikasi ini tidak merekam atau menyimpan video; favorit saja disimpan lokal di browser melalui `localStorage`.

## Pemeriksaan manual sebelum rilis

Lakukan pemeriksaan berikut di browser yang akan didukung. Catat tanggal dan hasil karena kondisi feed pihak ketiga cepat berubah.

1. Jalankan `node serve.js`, buka DevTools Console dan Network, lalu muat ulang halaman. Pastikan katalog kamera, pustaka peta, style/tile, dan skrip pemutar tidak gagal dimuat.
2. Pastikan basemap dan atribusi terlihat, jumlah kamera sesuai katalog, marker berada di sekitar lokasi yang dimaksud, dan kontrol zoom berfungsi.
3. Coba pencarian nama lokasi/wilayah, setiap filter wilayah, tombol Atur ulang, favorit, dan muat ulang halaman untuk memastikan favorit tersimpan.
4. Pilih kamera dari daftar dan marker peta. Pastikan judul, lokasi, status, dan tautan sumber berubah sesuai kamera; tutup player lalu pilih kamera lain.
5. Coba setidaknya satu feed Bali Tower HLS. Jika katalog kelak berisi jenis feed iframe, coba juga satu feed iframe. Tunggu hingga status berubah; pastikan pemutar menampilkan kegagalan atau buffering dengan pesan yang dapat dipahami saat feed tidak merespons. Klik **Buka sumber asli** untuk membandingkan perilaku sumber.
6. Pilih beberapa kamera dan pastikan masing-masing sesi dimulai sebagai belum diverifikasi; status live baru tampil setelah event `playing`. Pastikan buffering dan error tidak tercatat sebagai status provider yang persisten.
7. Uji navigasi keyboard, fokus yang terlihat, tombol `/` untuk pencarian, `Escape` untuk menutup player, dan status yang diumumkan teknologi bantu.
8. Periksa tampilan desktop dan ponsel: daftar kamera dapat digulir, panel player tidak menutupi kontrol peta, dan kontrol tetap dapat dipakai pada ukuran layar sempit.
9. Simulasikan koneksi terputus atau blokir host pihak ketiga. Pastikan kegagalan tidak merusak daftar/pencarian dan tidak ada label kamera yang menyiratkan semua feed aktif.

Pemeriksaan di atas adalah checklist manual, bukan automated test suite. Snapshot feed lama tidak menjamin hasil yang sama saat rilis; verifikasi ulang setiap sumber pada hari rilis.

## Referensi sumber

- Portal CCTV Publik DKI Jakarta: <https://jakcctv.jakarta.go.id/publik>
- Artikel daftar kandidat tautan CCTV Bali Tower: <https://news.detik.com/berita/d-8083199/cara-cek-cctv-jakarta-ini-daftar-link-pantau-lalin-dan-kondisi-kota>
