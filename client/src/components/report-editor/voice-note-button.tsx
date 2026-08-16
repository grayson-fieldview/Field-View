/**
 * Voice note recorder for the AI generate dialog — the app's first use of
 * getUserMedia/MediaRecorder.
 *
 * Records up to 5:00, uploads the blob straight to S3 (presigned PUT —
 * audio must not pass through Vercel's 4.5MB serverless body cap), then
 * POSTs the S3 key to /api/transcribe and hands the transcript to the
 * parent. Renders nothing when recording is unsupported; the textarea
 * alone still works.
 *
 * MediaStream tracks are stopped on EVERY exit path (stop, cap, error,
 * permission failure, unmount, forced stop via stopSignal) — a leaked track
 * leaves the browser's recording indicator on.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Mic, Square } from "lucide-react";

const MAX_SECONDS = 5 * 60; // hard cap 5:00 — auto-stop and transcribe, never discard
const WARN_SECONDS = 4 * 60; // counter turns warning color so the cap isn't a surprise
const MAX_MS = MAX_SECONDS * 1000;

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4"; // Safari
  return null;
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function VoiceNoteButton({
  onTranscript,
  onBusyChange,
  stopSignal,
}: {
  onTranscript: (text: string) => void;
  /** Reports recording/transcribing so the parent can disable Generate. */
  onBusyChange?: (busy: boolean) => void;
  /** Increment to force-stop any active recording (dialog close/reset). */
  stopSignal?: number;
}) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef(0);
  // "stop" (transcribe) vs "abort" (discard — unmount/dialog close).
  const stopModeRef = useRef<"stop" | "abort">("stop");
  // Generation token: bumped by every cleanup (close/unmount) and every new
  // start. A getUserMedia that resolves after its generation is stale must
  // release its tracks immediately; a transcription that resolves after its
  // generation is stale must drop its result. Also prevents double-start.
  const genRef = useRef(0);

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined" &&
    pickMimeType() !== null;

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  function clearTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (capTimeoutRef.current) {
      clearTimeout(capTimeoutRef.current);
      capTimeoutRef.current = null;
    }
  }

  /** Abort everything: invalidate in-flight work, stop recorder + tracks. */
  function abortAll() {
    genRef.current += 1; // stale-ify pending getUserMedia / transcription
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      stopModeRef.current = "abort";
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped
      }
    }
    clearTimer();
    releaseStream();
  }

  // Force-stop from parent (dialog reset-on-close): discard, don't transcribe.
  useEffect(() => {
    if (stopSignal === undefined) return;
    return abortAll; // cleanup on stopSignal change OR unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSignal]);

  // Belt-and-braces unmount cleanup (also covers stopSignal === undefined).
  useEffect(() => {
    return abortAll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onBusyChange?.(state !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  async function startRecording() {
    if (state !== "idle") return; // double-start guard
    setError(null);
    const mimeType = pickMimeType();
    if (!mimeType) return;
    const gen = ++genRef.current;
    setState("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (gen === genRef.current) {
        setState("idle");
        setError("Microphone access is blocked. Enable it in your browser settings, or type your note instead.");
      }
      return;
    }
    if (gen !== genRef.current) {
      // Cleanup (close/unmount) or a newer start ran while we awaited —
      // this stream is orphaned; release its tracks immediately.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    stopModeRef.current = "stop";

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      releaseStream();
      setState("idle");
      setError("Recording couldn't start. Type your note instead.");
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => {
      clearTimer();
      releaseStream();
      recorderRef.current = null;
      chunksRef.current = [];
      setState("idle");
      setError("Recording failed. Type your note instead.");
    };
    recorder.onstop = () => {
      clearTimer();
      releaseStream();
      recorderRef.current = null;
      const mode = stopModeRef.current;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      if (mode === "abort" || chunks.length === 0) {
        setState("idle");
        return;
      }
      void transcribe(new Blob(chunks, { type: mimeType }), mimeType, gen);
    };

    startedAtRef.current = Date.now();
    setElapsed(0);
    setState("recording");
    recorder.start(1000); // periodic chunks so a crash mid-recording loses little
    // Display timer derives elapsed from wall clock (interval ticks can be
    // throttled in background tabs — never trust tick counts).
    timerRef.current = setInterval(() => {
      setElapsed(Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAtRef.current) / 1000)));
    }, 500);
    // Hard cap: single absolute-deadline timeout — auto-stop and transcribe
    // what was captured, never discard it.
    capTimeoutRef.current = setTimeout(() => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        stopModeRef.current = "stop";
        recorderRef.current.stop();
      }
    }, MAX_MS);
  }

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      stopModeRef.current = "stop";
      recorderRef.current.stop();
    }
  }

  async function transcribe(blob: Blob, mimeType: string, gen: number) {
    setState("transcribing");
    try {
      // 1. Presign: server returns { key, uploadUrl, contentDisposition }.
      const ext = mimeType === "audio/mp4" ? "m4a" : mimeType === "audio/ogg" ? "ogg" : "webm";
      const signRes = await fetch("/api/uploads/sign", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ originalName: `voice-note.${ext}`, mimeType, fileSize: blob.size, folder: "audio" }],
        }),
      });
      if (gen !== genRef.current) return; // dialog closed/reset — drop result
      if (!signRes.ok) {
        const body = await signRes.json().catch(() => ({}));
        throw new Error(body.message || "Transcription failed. Please try again or type your note.");
      }
      const [signed] = await signRes.json();

      // 2. PUT straight to S3. The contentDisposition value is baked into
      // the signature — send it verbatim or S3 rejects the upload.
      const putHeaders: Record<string, string> = { "Content-Type": mimeType };
      if (signed.contentDisposition) putHeaders["Content-Disposition"] = signed.contentDisposition;
      const putRes = await fetch(signed.uploadUrl, { method: "PUT", headers: putHeaders, body: blob });
      if (!putRes.ok) {
        throw new Error("Transcription failed. Please try again or type your note.");
      }

      // 3. Transcribe from the key (server deletes the object after —
      // success or failure). NOTE: no staleness check between PUT and this
      // call. Once the object exists in S3, /api/transcribe is also its
      // cleanup trigger, so it must fire even if the dialog was closed;
      // staleness only decides whether the RESULT is applied below.
      const res = await fetch("/api/transcribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: signed.key }),
      });
      if (gen !== genRef.current) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Transcription failed. Please try again or type your note.");
      }
      const { transcript } = await res.json();
      if (gen !== genRef.current) return;
      if (typeof transcript === "string" && transcript.trim()) {
        onTranscript(transcript.trim());
      } else {
        setError("Nothing was transcribed. Try again or type your note.");
      }
    } catch (e) {
      if (gen !== genRef.current) return;
      setError((e as Error).message || "Transcription failed. Please try again or type your note.");
    } finally {
      if (gen === genRef.current) setState("idle");
    }
  }

  if (!supported) return null;

  return (
    <div className="flex items-center gap-2">
      {error && (
        <p className="text-xs text-destructive" data-testid="text-voice-error">
          {error}
        </p>
      )}
      {state === "recording" && (
        <span
          className={`text-xs tabular-nums ${elapsed >= WARN_SECONDS ? "text-destructive" : "text-muted-foreground"}`}
          data-testid="text-voice-elapsed"
        >
          {formatElapsed(elapsed)} / 5:00
        </span>
      )}
      {(state === "idle" || state === "starting") && (
        <Button type="button" variant="ghost" size="sm" onClick={startRecording} disabled={state === "starting"} data-testid="button-voice-record">
          <Mic className="h-4 w-4 mr-1.5" />
          Record
        </Button>
      )}
      {state === "recording" && (
        <Button type="button" variant="ghost" size="sm" onClick={stopRecording} data-testid="button-voice-stop">
          <Square className="h-4 w-4 mr-1.5 fill-current" />
          Stop
        </Button>
      )}
      {state === "transcribing" && (
        <Button type="button" variant="ghost" size="sm" disabled data-testid="button-voice-transcribing">
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          Transcribing...
        </Button>
      )}
    </div>
  );
}
