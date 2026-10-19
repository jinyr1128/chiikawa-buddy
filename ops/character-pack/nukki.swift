// GIF → 배경을 지운 움직이는 PNG(APNG). 장면마다 macOS Vision 피사체 분리로 배경을 투명하게.
// 사용: nukki <in.gif> <out.png>   출력: "<장면 수> <분리 성공 수>"
import Foundation
import Vision
import ImageIO
import CoreImage
import UniformTypeIdentifiers

let args = CommandLine.arguments
// 입력이 폴더면 그 안의 PNG 들을 순서대로 장면으로(영상에서 뽑은 장면), 장면 간격은 args[3] 초
var frameFiles: [URL] = []
var isDir: ObjCBool = false
if FileManager.default.fileExists(atPath: args[1], isDirectory: &isDir), isDir.boolValue {
  frameFiles = (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: args[1]), includingPropertiesForKeys: nil))?.filter { $0.pathExtension == "png" }.sorted { $0.lastPathComponent < $1.lastPathComponent } ?? []
}
let fixedDelay = args.count > 3 ? Double(args[3]) ?? 0.1 : 0.1
guard args.count >= 3, let src = frameFiles.isEmpty ? CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil) : CGImageSourceCreateWithURL(frameFiles[0] as CFURL, nil) else { print("0 0"); exit(1) }
let n = frameFiles.isEmpty ? CGImageSourceGetCount(src) : frameFiles.count
let ctx = CIContext()
let maxSide = Double(ProcessInfo.processInfo.environment["NUKKI_MAX"] ?? "360") ?? 360.0 // 더 크게: NUKKI_MAX=720
guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, n, nil) else { exit(1) }
CGImageDestinationSetProperties(dest, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGLoopCount: 0]] as CFDictionary)
var ok = 0
var lastMask: CIImage? = nil
for i in 0..<n {
  let fsrc = frameFiles.isEmpty ? src : (CGImageSourceCreateWithURL(frameFiles[i] as CFURL, nil) ?? src)
  guard let cg = CGImageSourceCreateImageAtIndex(fsrc, frameFiles.isEmpty ? i : 0, nil) else { continue }
  let props = frameFiles.isEmpty ? CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any] : nil
  let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
  var delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
  if !frameFiles.isEmpty { delay = fixedDelay }
  if delay < 0.02 { delay = 0.1 }
  let input = CIImage(cgImage: cg)
  var mask: CIImage? = nil
  let req = VNGenerateForegroundInstanceMaskRequest()
  let h = VNImageRequestHandler(cgImage: cg)
  if (try? h.perform([req])) != nil, let r = req.results?.first,
     let buf = try? r.generateScaledMaskForImage(forInstances: r.allInstances, from: h) {
    mask = CIImage(cvPixelBuffer: buf); ok += 1; lastMask = mask
  } else {
    mask = lastMask // 이 장면만 못 찾으면 바로 앞 장면 모양을 쓴다(깜빡이지 않게)
  }
  var out = input
  if let m = mask {
    let clear = CIImage(color: .clear).cropped(to: input.extent)
    out = input.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: clear, kCIInputMaskImageKey: m])
  }
  let s = min(1.0, maxSide / max(out.extent.width, out.extent.height))
  out = out.transformed(by: CGAffineTransform(scaleX: s, y: s))
  guard let outCG = ctx.createCGImage(out, from: out.extent) else { continue }
  CGImageDestinationAddImage(dest, outCG, [kCGImagePropertyPNGDictionary: [kCGImagePropertyAPNGDelayTime: delay]] as CFDictionary)
}
CGImageDestinationFinalize(dest)
print("\(n) \(ok)")
