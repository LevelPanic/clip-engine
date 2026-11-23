// faces <video> <startSec> <durationSec> <fps> [--no-landmarks]
// Samples frames from a range of a video and runs Apple Vision face detection on them.
// Prints JSON to stdout: { width, height, samples: [{ ms, faces: [{ x, y, w, h, mouth?, confidence }] }], cuts: [ms] }
// Boxes are normalised 0–1 with the origin at the top left; ms is source time. cuts are the first frames of new
// shots (hard cuts in the source), found from every decoded frame, not just the samples.
// Built and run by src/reframe/faces.ts (swiftc -O into .cache/bin/faces).
import AVFoundation
import Foundation
import Vision

struct Face: Encodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let mouth: Double?
  let confidence: Double
}

struct FaceRect: Encodable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let confidence: Double
}

struct Sample: Encodable {
  let ms: Int
  let faces: [Face]
  let rects: [FaceRect]
}

struct Output: Encodable {
  let width: Int
  let height: Int
  let samples: [Sample]
  let cuts: [Int]
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(Data((msg + "\n").utf8))
  exit(1)
}

func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }

/// Vision calls finish on several threads at once; this collects their results.
final class Collector: @unchecked Sendable {
  private let lock = NSLock()
  private var samples: [Sample] = []
  func add(_ s: Sample) {
    lock.lock()
    samples.append(s)
    lock.unlock()
  }
  func sorted() -> [Sample] {
    lock.lock()
    defer { lock.unlock() }
    return samples.sorted { $0.ms < $1.ms }
  }
}

/// Mouth openness: inner-lip gap over outer-lip width, in pixels so the face box's aspect doesn't skew it.
/// Talking makes it swing from ~0 to ~0.3+; the planner looks at how much it varies, not its level.
func mouthOpenness(_ face: VNFaceObservation, _ size: CGSize) -> Double? {
  guard let lm = face.landmarks, let inner = lm.innerLips, let outer = lm.outerLips,
    inner.pointCount > 0, outer.pointCount > 0
  else { return nil }
  let ip = inner.pointsInImage(imageSize: size)
  let op = outer.pointsInImage(imageSize: size)
  let gap = (ip.map(\.y).max()! - ip.map(\.y).min()!)
  let width = (op.map(\.x).max()! - op.map(\.x).min()!)
  return width > 0 ? Double(gap / width) : nil
}

func detect(_ pixels: CVPixelBuffer, landmarks: Bool) -> ([Face], [FaceRect]) {
  let size = CGSize(width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))
  let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:])
  // Rectangles first, then landmarks on those faces. Left to itself the landmarks request detects
  // with an older model that misses most small faces in wide shots, and its confidence is always 1.
  let faceReq = VNDetectFaceRectanglesRequest()
  do { try handler.perform([faceReq]) } catch { return ([], []) }
  var found = faceReq.results ?? []
  if landmarks && !found.isEmpty {
    let marks = VNDetectFaceLandmarksRequest()
    marks.inputFaceObservations = found
    if (try? handler.perform([marks])) != nil, let withMarks = marks.results, withMarks.count == found.count {
      found = withMarks
    }
  }
  let faces = found.map { f in
    let b = f.boundingBox  // bottom-left origin
    return Face(
      x: round4(b.minX), y: round4(1 - b.maxY), w: round4(b.width), h: round4(b.height),
      mouth: landmarks ? mouthOpenness(f, size).map(round4) : nil,
      confidence: round4(Double(f.confidence)))
  }

  // Rectangles are the webcam/overlay borders: a stable rectangle with a persistent face inside
  // is the facecam panel, which gives us the full panel bounds instead of guessing from the face.
  let panels = VNDetectRectanglesRequest()
  panels.minimumAspectRatio = 0.4
  panels.maximumAspectRatio = 3.0
  panels.minimumSize = 0.04
  panels.minimumConfidence = 0.35
  panels.quadratureTolerance = 30
  panels.maximumObservations = 20
  var rects: [FaceRect] = []
  if (try? handler.perform([panels])) != nil {
    rects = (panels.results ?? []).map { r in
      let b = r.boundingBox
      return FaceRect(
        x: round4(b.minX), y: round4(1 - b.maxY), w: round4(b.width), h: round4(b.height),
        confidence: round4(Double(r.confidence)))
    }
  }
  return (faces, rects)
}

/// Hard cuts: compares a coarse luma grid of each frame with the previous frame. A cut changes most of the picture
/// in one frame, so its difference is a spike well above the frames on either side; camera motion raises the
/// difference for many frames in a row, and a flash or a dissolve doesn't make a single spike.
final class CutDetector {
  static let cols = 64
  static let rows = 36
  private var prev: [UInt8]?
  private var diffs: [(ms: Int, diff: Double)] = []  // the last three frame differences
  private(set) var cuts: [Int] = []

  func add(_ pixels: CVPixelBuffer, ms: Int) {
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard CVPixelBufferGetPlaneCount(pixels) > 0, let base = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else { return }
    let w = CVPixelBufferGetWidthOfPlane(pixels, 0)
    let h = CVPixelBufferGetHeightOfPlane(pixels, 0)
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0)
    let luma = base.assumingMemoryBound(to: UInt8.self)
    var grid = [UInt8](repeating: 0, count: Self.cols * Self.rows)
    for gy in 0..<Self.rows {
      let row = luma + ((2 * gy + 1) * h / (2 * Self.rows)) * stride
      for gx in 0..<Self.cols { grid[gy * Self.cols + gx] = row[(2 * gx + 1) * w / (2 * Self.cols)] }
    }
    defer { prev = grid }
    guard let prev else { return }
    var sum = 0
    for k in 0..<grid.count { sum += abs(Int(grid[k]) - Int(prev[k])) }
    diffs.append((ms, Double(sum) / Double(grid.count)))
    if diffs.count > 3 { diffs.removeFirst() }
    // Judge the middle frame once the one after it is known.
    guard diffs.count == 3 else { return }
    let (before, mid, after) = (diffs[0].diff, diffs[1], diffs[2].diff)
    let spike = mid.diff > 20 && mid.diff > 1.6 * max(before, after) + 5
    if spike && mid.ms - (cuts.last ?? Int.min / 2) > 300 { cuts.append(mid.ms) }
  }
}

/// The async track loader, made synchronous (this is a one-shot CLI).
func videoTrack(_ asset: AVURLAsset) -> AVAssetTrack? {
  final class Box: @unchecked Sendable { var track: AVAssetTrack? }
  let box = Box()
  let done = DispatchSemaphore(value: 0)
  asset.loadTracks(withMediaType: .video) { tracks, _ in
    box.track = tracks?.first
    done.signal()
  }
  done.wait()
  return box.track
}

let args = CommandLine.arguments.filter { !$0.hasPrefix("--") }
guard args.count == 5, let startSec = Double(args[2]), let durSec = Double(args[3]), let fps = Double(args[4]),
  startSec >= 0, durSec > 0, fps > 0
else { fail("usage: faces <video> <startSec> <durationSec> <fps> [--no-landmarks]") }
let useLandmarks = !CommandLine.arguments.contains("--no-landmarks")

let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = videoTrack(asset) else { fail("no video track in \(args[1])") }

// AVAssetReader decodes every frame in the range in order (hardware H.264/HEVC decode), which is far
// faster than seeking per sample: each seek would decode from the previous keyframe again.
// 420v is the decoder's native format, so there is no colour conversion before Vision.
let reader: AVAssetReader
do { reader = try AVAssetReader(asset: asset) } catch { fail("can't read \(args[1]): \(error)") }
let output = AVAssetReaderTrackOutput(
  track: track,
  outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
output.alwaysCopiesSampleData = false
reader.add(output)
reader.timeRange = CMTimeRange(
  start: CMTime(seconds: startSec, preferredTimescale: 90000),
  duration: CMTime(seconds: durSec, preferredTimescale: 90000))
guard reader.startReading() else { fail("can't start reading: \(String(describing: reader.error))") }

// Vision runs on a few threads while the reader keeps decoding. Only a few frames are in flight,
// because the reader's buffer pool is small and holding more stalls the decoder.
let queue = DispatchQueue(label: "faces.vision", qos: .userInitiated, attributes: .concurrent)
let group = DispatchGroup()
let slots = DispatchSemaphore(value: 4)
let collector = Collector()
let cutDetector = CutDetector()
let step = 1 / fps
let endSec = startSec + durSec
var next = startSec
var width = 0
var height = 0
var halfFrame: Double?  // half the source frame interval, from the first two timestamps
var lastPts: Double?

while let buffer = output.copyNextSampleBuffer() {
  guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
  let pts = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
  if halfFrame == nil, let last = lastPts, pts > last { halfFrame = (pts - last) / 2 }
  lastPts = pts
  if pts >= endSec { break }
  cutDetector.add(pixels, ms: Int((pts * 1000).rounded()))
  // Take the frame nearest each sample time.
  let half = halfFrame ?? 0.001
  if pts + half < next { continue }
  while next <= pts + half { next += step }
  width = CVPixelBufferGetWidth(pixels)
  height = CVPixelBufferGetHeight(pixels)
  let ms = Int((pts * 1000).rounded())
  slots.wait()
  group.enter()
  queue.async {
    defer {
      slots.signal()
      group.leave()
    }
    let (faces, rects) = detect(pixels, landmarks: useLandmarks)
    collector.add(Sample(ms: ms, faces: faces, rects: rects))
  }
}
group.wait()
if reader.status == .failed { fail("reading failed: \(String(describing: reader.error))") }
reader.cancelReading()

let encoder = JSONEncoder()
do {
  let data = try encoder.encode(Output(width: width, height: height, samples: collector.sorted(), cuts: cutDetector.cuts))
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch { fail("can't encode JSON: \(error)") }
