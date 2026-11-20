// macOS 13+ native audio helper. Run before packaging on macOS.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function buildMeetingAudio(output=path.join(root,'native','bin','meeting-audio')){
 fs.mkdirSync(path.dirname(output),{recursive:true});
 execFileSync('clang',['-arch',process.argv.includes('--arch=x64')?'x86_64':'arm64','-fobjc-arc','-O2','-framework','Cocoa',path.join(root,'native','swap-update.m'),'-o',path.join(path.dirname(output),'swap-update')],{stdio:'inherit'});
 execFileSync('clang',['-arch',process.argv.includes('--arch=x64')?'x86_64':'arm64','-O2','-framework','ApplicationServices',path.join(root,'native','typing-activity.c'),'-o',path.join(path.dirname(output),'typing-activity')],{stdio:'inherit'});
 execFileSync('swiftc',['-target',process.argv.includes('--arch=x64')?'x86_64-apple-macos13.0':'arm64-apple-macos13.0','-parse-as-library',path.join(root,'native/meeting-audio.swift'),'-o',output,'-framework','ScreenCaptureKit','-framework','AVFoundation','-framework','AppKit','-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',path.join(root,'native/meeting-audio.plist')],{stdio:'inherit'});return output;
}
if(process.argv[1]===fileURLToPath(import.meta.url))buildMeetingAudio(process.argv[2]);
