// audio-events <audio-or-video-file> [--floor 0.3] [--all]
//
// Runs Apple's built-in sound classifier (SoundAnalysis, classifier version1, ~300 labels) over a
// file and prints the windows where audience-reaction sounds were heard, as JSON on stdout:
//   { "durationMs", "windowMs", "hopMs", "events": [{ "ms", "label", "confidence" }] }
// `ms` is the start of the analysis window. Only the watch labels above a low floor are kept so the
// TypeScript side can pick the real threshold without re-running the analysis.
// --all keeps every label above the floor (for tuning which labels to watch).
// Progress goes to stderr. Reads anything Core Audio reads; src/ingest/audioEvents.ts hands it a
// mono 16 kHz WAV (the rate the classifier states its window limits in) because some muxed mp4s
// don't read in full.
import AVFoundation
import Foundation
import SoundAnalysis

let windowSeconds = 1.5
let overlap = 0.5 // hop 0.75 s: any sound up to 0.75 s long falls wholly inside some window

// Laughs, crowd reactions and raised voices: the sounds that mark a payoff. Broader than what the
// signal uses (src/discover/signals/audio.ts) so it can be retuned without re-analysing.
let watch: Set<String> = [
  "laughter", "belly_laugh", "giggling", "chuckle_chortle", "snicker",
  "applause", "clapping", "cheering", "crowd",
  "shout", "yell", "screaming", "battle_cry", "children_shouting",
  "gasp", "booing",
]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("audio-events: \(message)\n".utf8))
  exit(1)
}

var floor = 0.3
var keepAll = false
var input: String?
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
  switch a {
  case "--floor":
    guard let v = args.popFirst().flatMap(Double.init) else { fail("--floor needs a number") }
    floor = v
  case "--all": keepAll = true
  case "-h", "--help":
    print("usage: audio-events <audio-or-video-file> [--floor 0.3] [--all]")
    exit(0)
  default: input = a
  }
}
guard let path = input else { fail("usage: audio-events <audio-or-video-file> [--floor 0.3] [--all]") }
guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)") }
let url = URL(fileURLWithPath: path)

struct Event: Encodable {
  let ms: Int
  let label: String
  let confidence: Double
}

struct Output: Encodable {
  let durationMs: Int
  let windowMs: Int
  let hopMs: Int
  let events: [Event]
}

final class Collector: NSObject, SNResultsObserving {
  let floor: Double
  let keep: (String) -> Bool
  let durationS: Double
  var events: [Event] = []
  var failure: Error?
  private var nextReportS = 600.0

  init(floor: Double, durationS: Double, keep: @escaping (String) -> Bool) {
    self.floor = floor
    self.durationS = durationS
    self.keep = keep
  }

  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let r = result as? SNClassificationResult else { return }
    let startS = r.timeRange.start.seconds
    let ms = Int((startS * 1000).rounded())
    for c in r.classifications where c.confidence >= floor && keep(c.identifier) {
      events.append(Event(ms: ms, label: c.identifier, confidence: (c.confidence * 1000).rounded() / 1000))
    }
    if startS >= nextReportS {
      nextReportS += 600
      let line = String(format: "audio-events: %.0f / %.0f min\n", startS / 60, durationS / 60)
      FileHandle.standardError.write(Data(line.utf8))
    }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    failure = error
  }
}

do {
  // AVAudioFile reads the audio track of mp4/mov/m4a/wav; it also gives us the duration.
  let file = try AVAudioFile(forReading: url)
  let durationS = Double(file.length) / file.processingFormat.sampleRate

  // Core Audio silently stops early on some muxed mp4s (a 2 h YouTube livestream read as 1:46),
  // so compare with the container's audio track and refuse rather than return partial results.
  let asset = AVURLAsset(url: url)
  if let track = try await asset.loadTracks(withMediaType: .audio).first {
    let trackS = CMTimeRangeGetEnd(try await track.load(.timeRange)).seconds
    if trackS.isFinite && durationS < trackS * 0.99 - 2 {
      fail(String(
        format: "Core Audio reads only %.1f of %.1f min of audio in %@. Extract it first: ffmpeg -i <file> -vn -ac 1 -ar 16000 audio.wav",
        durationS / 60, trackS / 60, url.lastPathComponent
      ))
    }
  }

  let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
  request.windowDuration = CMTime(seconds: windowSeconds, preferredTimescale: 48_000)
  request.overlapFactor = overlap

  let collector = Collector(floor: floor, durationS: durationS, keep: { keepAll || watch.contains($0) })
  let analyzer = try SNAudioFileAnalyzer(url: url)
  try analyzer.add(request, withObserver: collector)
  analyzer.analyze() // synchronous: returns when the whole file has been classified
  if let e = collector.failure { fail("analysis failed: \(e.localizedDescription)") }

  let out = Output(
    durationMs: Int((durationS * 1000).rounded()),
    windowMs: Int((windowSeconds * 1000).rounded()),
    hopMs: Int((windowSeconds * (1 - overlap) * 1000).rounded()),
    events: collector.events
  )
  let enc = JSONEncoder()
  enc.outputFormatting = [.sortedKeys]
  FileHandle.standardOutput.write(try enc.encode(out))
  FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
  fail("\(path): \(error.localizedDescription)")
}
