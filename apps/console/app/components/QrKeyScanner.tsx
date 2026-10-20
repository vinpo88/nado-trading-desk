"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { CameraIcon, StopIcon } from "@phosphor-icons/react";

/** Normalize a scanned string to a 0x-prefixed 64-hex EVM private key, or null if it isn't one.
 *  Accepts the raw 64 hex or a 0x-prefixed form; the final curve-range check is wative's on import. */
function normalizePrivateKey(s: string): string | null {
  const m = s.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  return m ? `0x${m[1]}` : null;
}

// BarcodeDetector is a browser-native API (Chromium); not in lib.dom, so declare the slice we use.
interface BarcodeDetectorLike { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
interface BarcodeDetectorCtor { new (opts?: { formats?: string[] }): BarcodeDetectorLike }

/** Import a private key WITHOUT the clipboard: click → browser camera-permission prompt → live QR
 *  scan → on a QR that decodes to a valid EVM private key, calls onKey(key) and stops the camera.
 *  Falls back with a clear message when the browser has no BarcodeDetector / camera. */
export function QrKeyScanner({ onKey, disabled }: { onKey: (key: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setOpen(false);
  };
  useEffect(() => () => stop(), []); // stop the camera if the block unmounts mid-scan

  const start = async () => {
    setErr(null);
    const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) { setErr("当前浏览器不支持扫码，请改用粘贴私钥。"); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setErr("当前浏览器无法使用摄像头。"); return; }
    setOpen(true);
    try {
      // Prompts for camera approval the first time, then opens directly. Rear camera when present.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) { stop(); return; }
      v.srcObject = stream;
      await v.play();
      const detector = new Ctor({ formats: ["qr_code"] });
      const tick = async () => {
        if (!streamRef.current || !videoRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          const hit = codes.map((c) => normalizePrivateKey(c.rawValue)).find(Boolean);
          if (hit) { onKey(hit); stop(); return; }           // valid private key → hand it off, no clipboard
          if (codes.length) setErr("扫描到的二维码不是私钥，请将私钥二维码保持在画面中。");
        } catch { /* transient per-frame decode error — keep scanning */ }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setErr("摄像头权限被拒绝或设备不可用。");
      stop();
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      {open ? (
        <>
          <video ref={videoRef} muted playsInline aria-label="私钥二维码扫描画面" className="w-full max-w-xs rounded-lg bg-kumo-recessed ring ring-kumo-line" />
          <Button size="sm" icon={StopIcon} onClick={stop}>关闭摄像头</Button>
        </>
      ) : (
        <Button size="sm" icon={CameraIcon} disabled={disabled} onClick={start}>用摄像头扫描二维码</Button>
      )}
      {!open && <Text variant="secondary" size="xs">直接扫描私钥二维码，无需经过剪贴板。</Text>}
      {err && <Text variant="error" size="xs">{err}</Text>}
    </div>
  );
}
