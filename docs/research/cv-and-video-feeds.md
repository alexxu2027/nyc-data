# Research notes: computer vision & live video feeds (2026-11-14)

Background research from the planning session that led to NYC Live. Phase 4 (cameras as
sensors) builds on this. Facts about specific feeds were checked on 2026-11-14. Stream
availability changes, so re-check before relying on any one feed.

## Hardware reality
- **Laptop:** Snapdragon X Elite (ARM, 12 cores), 32 GB RAM, Qualcomm Adreno GPU. No CUDA, so PyTorch
  runs on the CPU only.
- **Python:** uv's Python 3.12 and the system 3.14 are both **x64 builds running emulated** on ARM
  (`sys.version` shows AMD64). PyTorch works but is slower. PyTorch has had native Windows
  ARM64 CPU wheels since 2.7. OpenCV on Windows ARM is less certain, so confirm both install before
  switching (see ADR-002).
- **Desktop PC with an RTX 3050:** not set up yet. It's the planned always-on box and the GPU for
  CV. Code stays device-agnostic (`device="cuda"` vs `"cpu"`).
- **Expectations:** small YOLO (`yolo11n`/`s`) runs at roughly 5–10 FPS on a CPU, which is enough
  for sampled counting. Training custom detectors belongs on Colab, Kaggle or the 3050.

## DOT cameras (NYC Live's primary CV input)
- 974 cameras (874 online) at `webcams.nyctmc.org/api/cameras`. Frames are 352×240 JPEGs, about
  17 KB each, with a new frame roughly every 2 s.
- **Implications:** tracking and line-crossing counts don't work, because objects jump too far
  between frames. Per-frame counts and occupancy over time do work. Pedestrians and bikes in the
  distance are often missed.
- **Tricks:** upscale with `imgsz=1280`, crop to a region of interest (near lanes or the
  intersection), tune confidence per class, pick sharp close cameras, and later fine-tune on
  hand-labeled DOT frames.
- Low FPS has an upside: one CPU can sample dozens of cameras.

## YouTube live streams (higher FPS, so tracking is possible; an optional later add-on)
Ingest with `yt-dlp -g <url>` or `streamlink` to get a stream URL, read it with OpenCV, then run
Ultralytics YOLO. Save each channel's "Live" tab rather than a single video URL, because streams
restart.
- **Intersections and streets:** City of Springboro Live Traffic
  (youtube.com/@SPRTrafficCameras/streams), Jackson Hole Town Square (SeeJH), Shibuya Scramble
  Crossing (several channels), Brazilian street cams. For directories, see camlisted.com
  (~3,900 YouTube live cams) and worldcam.tv/category/traffic.
- **Trains, planes, ports:** Virtual Railfan (24/7 rail cams), airport plane-spotting streams
  (often scheduled rather than 24/7), harbor cams.
- **Wildlife:** Cornell Lab Bird Cams (youtube.com/@cornelllabbirdcams), BirdWatchingHQ in Ohio
  (50+ species), the Gettysburg feeder, Canadian Bird Nerd, Wildlife Kate. Explore.org's Katmai
  bears are seasonal (about June–October).
- Example code: dev.to/spring93/building-real-time-object-detection-on-live-streams-46ja; the
  Hugging Face Space aai521-group6/youtube-object-detection (Streamlink + YOLO + Gradio).

## Model menu (for later experiments)
| Task | Options |
|---|---|
| Detection | Ultralytics YOLO (v8/11), RT-DETR |
| Open-vocabulary detection | Grounding DINO, OWLv2, YOLO-World |
| Segmentation | SAM 2 |
| Embeddings/search | CLIP, SigLIP, DINOv2 |
| Depth | Depth Anything V2 |
| Pose | MediaPipe, YOLO-pose |
| Tracking | ByteTrack / BoT-SORT (built into `model.track`). Needs high-FPS video, not DOT cams |
| Overlay tooling | `supervision` (Roboflow): line zones, heatmaps, annotators |

## Privacy
Count objects; don't identify anyone. No face or plate recognition, and no tracking individuals.
Keep frames briefly (see PRD §8).
