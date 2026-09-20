"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reading a tag with the phone's camera.
 *
 * On the shop floor the scanner is a gun on a cable, and the till is a laptop.
 * On a phone — at a bazaar, or walking the rail with a customer — there is no
 * gun, and typing an eight-character code off a tag with somebody waiting is
 * the reason people stop using the tag at all.
 *
 * What it reads goes exactly where the gun's keystrokes go, so nothing
 * downstream knows the difference: the same serial lookup, the same search,
 * the same basket.
 *
 * The browser's own reader is used where there is one: Chrome on Android has
 * it, and it is fast and costs nothing to load. Where there is none — every
 * iPhone, because Apple requires all iOS browsers to use WebKit and WebKit
 * has no barcode reader, so Chrome there is Safari underneath — a WebAssembly
 * reader is fetched instead, and only then. An Android phone never downloads
 * it; an iPhone downloads it once, when the camera button is first pressed.
 *
 * Its binary is served from this site rather than a CDN, so a shop on a poor
 * line does not lose scanning because somebody else's server is slow.
 */

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

type DetectorOptions = { formats?: readonly string[] };

declare global {
  interface Window {
    BarcodeDetector?: new (options?: DetectorOptions) => BarcodeDetectorLike;
  }
}

export function CameraScanner({
  ar,
  onScan,
}: {
  ar: boolean;
  /** Called with what was read, once, before the camera is put away. */
  onScan: (value: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // A camera is the only thing that cannot be supplied: the reader can be.
  useEffect(() => {
    setSupported(!!navigator.mediaDevices?.getUserMedia);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;

    (async () => {
      try {
        // The back camera: nobody photographs a price tag with the front one.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        // What the shop's own tags carry, plus the codes printed on bought-in
        // goods, so a supplier's barcode is read as readily as ours.
        // `as const`, because the WebAssembly reader types its formats as a
        // union of the codes it knows rather than plain strings.
        const formats = ["code_128", "code_39", "ean_13", "ean_8", "qr_code"] as const;

        let detector: BarcodeDetectorLike;
        if (typeof window.BarcodeDetector === "function") {
          detector = new window.BarcodeDetector({ formats });
        } else {
          setLoading(true);
          // Imported here and nowhere else, so the reader is downloaded by the
          // phones that need it at the moment they need it, and by no others.
          const { BarcodeDetector, setZXingModuleOverrides } = await import(
            "barcode-detector/ponyfill"
          );
          setZXingModuleOverrides({
            locateFile: (file: string, prefix: string) =>
              file.endsWith(".wasm") ? "/zxing/zxing_reader.wasm" : prefix + file,
          });
          detector = new BarcodeDetector({ formats: [...formats] });
          if (cancelled) return;
          setLoading(false);
        }

        const read = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const value = found[0]?.rawValue?.trim();
            if (value) {
              onScan(value);
              setOpen(false);
              return;
            }
          } catch {
            // A frame that cannot be read is ordinary: the camera is still
            // focusing, or the tag is at an angle. Try the next one.
          }
          timer = window.setTimeout(read, 250);
        };
        void read();
      } catch {
        setError(
          ar
            ? "مفيش إذن للكاميرا. اسمح للكاميرا من إعدادات المتصفح وجرّب تاني."
            : "No camera permission. Allow the camera in the browser settings and try again.",
        );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open, ar, onScan]);

  if (!supported) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="rounded-lg border border-ink-200 px-3 py-2 text-sm font-medium text-ink-700"
      >
        {ar ? "امسح بالكاميرا" : "Scan with the camera"}
      </button>

      {error && <p className="mt-2 text-xs text-bad">{error}</p>}

      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ink-950">
          <video
            ref={videoRef}
            playsInline
            muted
            className="min-h-0 flex-1 object-cover"
          />
          {/* A window to aim through: without one people hold the tag too close
              and the camera never focuses. */}
          <div className="pointer-events-none absolute inset-x-8 top-1/3 h-28 rounded-lg border-2 border-white/80" />
          <div className="flex items-center justify-between gap-3 p-4">
            <p className="text-sm text-white/80">
              {loading
                ? ar
                  ? "بنجهّز القارئ…"
                  : "Getting the reader ready…"
                : ar
                  ? "صوّب على الباركود"
                  : "Point at the barcode"}
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-ink-900"
            >
              {ar ? "إلغاء" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
