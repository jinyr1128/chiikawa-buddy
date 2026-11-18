import Foundation
import AppKit
import AVFoundation
import ScreenCaptureKit
import CoreMedia

func emit(_ obj: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data:d,encoding:.utf8) { print(s); fflush(stdout) } }
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    let url: URL
    var file: AVAudioFile?
    var frames: Int64 = 0
    var firstAt: Date?
    init(_ url: URL) { self.url = url }
    func stream(_ stream: SCStream, didStopWithError error: Error) { emit(["error":"회의 앱 오디오 캡처가 중단됐습니다."]); exit(2) }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid, let desc = sample.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: desc)
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sample.numSamples)) else { return }
        pcm.frameLength = pcm.frameCapacity
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at:0, frameCount:Int32(sample.numSamples), into:pcm.mutableAudioBufferList) == noErr else { return }
        do {
            if file == nil { file = try AVAudioFile(forWriting:url,settings:format.settings,commonFormat:format.commonFormat,interleaved:format.isInterleaved) }
            if firstAt == nil { firstAt = Date() }; try file!.write(from:pcm); frames += Int64(pcm.frameLength)
        } catch { emit(["error":"회의 오디오 저장 실패. 디스크 여유 공간을 확인하세요."]); exit(3) }
    }
}
@main struct Main {
    static func main() async {
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "list" {
            let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
            let data = apps.map { ["id":$0.bundleIdentifier!,"name":$0.localizedName ?? $0.bundleIdentifier!] }
            if let d=try? JSONSerialization.data(withJSONObject:data),let s=String(data:d,encoding:.utf8){ print(s) };return
        }
        guard args.count == 4 else { emit(["error":"녹음 인수가 올바르지 않습니다."]);exit(1) }
        let dir=URL(fileURLWithPath:args[2],isDirectory:true), mode=args[1], bundle=args[3]
        guard mode == "mic" || mode == "online" else {exit(1)}
        guard await AVCaptureDevice.requestAccess(for:.audio) else {emit(["error":"마이크 권한을 허용한 뒤 다시 시작하세요."]);exit(1)}
        var stream: SCStream?
        let sink=AudioSink(dir.appendingPathComponent("system.caf"))
        do {
            if mode == "online" {
                let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
                guard let display=content.displays.first, let app=content.applications.first(where:{$0.bundleIdentifier==bundle}) else {throw NSError(domain:"선택한 회의 앱을 먼저 실행하세요.",code:1)}
                let filter=SCContentFilter(display:display,including:[app],exceptingWindows:[])
                let config=SCStreamConfiguration();config.capturesAudio=true;config.excludesCurrentProcessAudio=true
                config.sampleRate=48000;config.channelCount=2;config.width=2;config.height=2;config.minimumFrameInterval=CMTime(value:1,timescale:1)
                let s=SCStream(filter:filter,configuration:config,delegate:sink)
                try s.addStreamOutput(sink,type:.audio,sampleHandlerQueue:DispatchQueue(label:"meeting-audio"))
                stream=s
            }
            let mic=try AVAudioRecorder(url:dir.appendingPathComponent("microphone.wav"),settings:[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:16000,AVNumberOfChannelsKey:1,AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsBigEndianKey:false])
            guard mic.record() else {throw NSError(domain:"마이크 녹음 시작 실패",code:2)}
            let start=Date()
            if let s=stream {try await s.startCapture()}
            emit(["ready":true,"mode":mode])
            // Parent pipe closes on app crash; finalize audio rather than keep recording invisibly.
            _ = await Task.detached { readLine() }.value
            if let s=stream {try await s.stopCapture()}
            mic.stop();sink.file=nil
            emit(["stopped":true,"seconds":Date().timeIntervalSince(start),"systemFrames":sink.frames,"systemOffsetSeconds":max(0, sink.firstAt?.timeIntervalSince(start) ?? 0)])
        } catch {emit(["error":"녹음 시작/종료 실패. 마이크·화면 및 시스템 오디오 권한과 저장 공간을 확인하세요."]);exit(1)}
    }
}
