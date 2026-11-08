import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// the original file stays in the project root; Vite serves it in dev and hashes/copies it into dist on build
import introSrc from '../../intro.mp4';
import { useApp } from '../lib/app';
import { copyText, shortAddr } from '../lib/format';
import { BRAND, LogoMark } from './Brand';
import { ICheck, ICopy, IExt, IXLogo } from './Icons';
import '../styles/intro.css';

const FADE_MS = 360; // keep in sync with the .intro transition in intro.css
const VIDEO_FADE_MS = 1400; // keep in sync with .intro-video.done in intro.css
const STALL_MS = 9000; // if the video has shown nothing by then (very slow link), go straight to the landing screen

type Phase = 'video' | 'landing' | 'leaving' | 'gone';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Opening screen, shown on every page load. It plays the intro video exactly ONCE (no loop) and settles on the
 * landing screen: wordmark, LAUNCH, the project's contract address and its links. The app underneath is inert
 * until the visitor presses LAUNCH. SKIP jumps from the video to the landing screen.
 */
export default function Intro() {
  const { config, evmCfg, evmName, toast } = useApp();
  const [phase, setPhase] = useState<Phase>(() => (reducedMotion() ? 'landing' : 'video'));
  const [ready, setReady] = useState(false);
  const [videoMounted, setVideoMounted] = useState(() => !reducedMotion());
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const launchRef = useRef<HTMLButtonElement>(null);

  const showLanding = useCallback(() => setPhase((p) => (p === 'video' ? 'landing' : p)), []);
  const enterApp = useCallback(() => setPhase((p) => (p === 'landing' ? 'leaving' : p)), []);

  // while the intro is up the app underneath can be neither tabbed into nor scrolled
  useEffect(() => {
    if (phase === 'leaving' || phase === 'gone') return;
    const root = document.getElementById('root');
    const prevOverflow = document.body.style.overflow;
    root?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    return () => {
      root?.removeAttribute('inert');
      document.body.style.overflow = prevOverflow;
    };
  }, [phase]);

  // autoplay (muted + inline) is allowed almost everywhere; if the browser still refuses, skip to the landing screen
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    if (v.readyState >= 2) setReady(true); // already buffered (cached)
    v.play().catch(showLanding);
  }, [showLanding]);

  // a link too slow to show the video should not leave the visitor staring at a blank screen
  useEffect(() => {
    if (phase !== 'video' || ready) return;
    const t = setTimeout(showLanding, STALL_MS);
    return () => clearTimeout(t);
  }, [phase, ready, showLanding]);

  // landing screen: stop the video, let it fade out, then drop it; put the keyboard on LAUNCH
  useEffect(() => {
    if (phase !== 'landing') return;
    videoRef.current?.pause();
    launchRef.current?.focus({ preventScroll: true });
    const t = setTimeout(() => setVideoMounted(false), VIDEO_FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setPhase('gone'), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  if (phase === 'gone') return null;

  const ca = config?.project.tokenCa ?? null;
  const xUrl = config?.project.xUrl ?? 'https://x.com/useelytheia';
  const xHandle = '@' + (xUrl.replace(/\/+$/, '').split('/').pop() ?? 'useelytheia');
  const onLanding = phase !== 'video';

  const copy = async () => {
    if (!ca) return;
    const ok = await copyText(ca);
    setCopied(ok);
    toast(ok ? 'Contract address copied' : 'Copy failed', ok ? 'ok' : 'err');
  };

  return createPortal(
    <div
      className={`intro${onLanding ? ' landing' : ''}${phase === 'leaving' ? ' leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${BRAND}`}
    >
      {/* the landing backdrop: always loaded, only revealed once the video is over */}
      <img className="intro-bg" src="/brand/hero.jpg" alt="" decoding="async" />

      {videoMounted && (
        <video
          ref={videoRef}
          className={`intro-video${ready ? ' ready' : ''}${onLanding ? ' done' : ''}`}
          src={introSrc}
          autoPlay
          muted
          playsInline
          preload="auto"
          aria-hidden="true"
          onLoadedData={() => setReady(true)}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (barRef.current && v.duration) barRef.current.style.transform = `scaleX(${Math.min(1, v.currentTime / v.duration)})`;
          }}
          onEnded={showLanding}
          onError={showLanding}
        />
      )}
      <div className="intro-scrim" aria-hidden="true" />

      {phase === 'video' && (
        <>
          <div className="intro-progress" aria-hidden="true">
            <div ref={barRef} />
          </div>
          <button type="button" className="intro-skip" onClick={showLanding}>
            <span>SKIP</span>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path d="M6 5l7 7-7 7M13 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </>
      )}

      {onLanding && (
        <div className="landing-body">
          <div className="landing-emblem l-in" style={{ ['--d' as string]: '0.15s' }}>
            <LogoMark size={112} />
          </div>
          <h1 className="landing-title l-in" style={{ ['--d' as string]: '0.3s' }}>
            {BRAND.toUpperCase()}
          </h1>
          <p className="landing-tag l-in" style={{ ['--d' as string]: '0.5s' }}>
            One launch. Every chain.
          </p>

          <button ref={launchRef} type="button" className="intro-launch l-in" style={{ ['--d' as string]: '0.7s' }} onClick={enterApp}>
            <span>LAUNCH</span>
          </button>

          <p className="landing-desc l-in" style={{ ['--d' as string]: '0.85s' }}>
            Launch and trade coins on Solana{evmCfg ? ` and ${evmName}` : ''}, straight from your own wallet. Free to launch.
          </p>

          <div className="landing-links l-in" style={{ ['--d' as string]: '1s' }}>
            <div className={`ca-pill${ca ? '' : ' soon'}`}>
              <span className="ca-label">CA</span>
              {ca ? (
                <>
                  <code className="ca-addr" title={ca}>
                    <span className="ca-full">{ca}</span>
                    <span className="ca-short">{shortAddr(ca, 6, 6)}</span>
                  </code>
                  <button type="button" className={`ca-copy${copied ? ' ok' : ''}`} onClick={copy} aria-label="Copy contract address">
                    {copied ? <ICheck size={13} /> : <ICopy size={13} />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </>
              ) : (
                <span className="ca-addr muted">{config ? 'Coming soon' : '…'}</span>
              )}
            </div>
            {ca && (
              <a className="ca-link" href={`https://pump.fun/coin/${ca}`} target="_blank" rel="noopener noreferrer">
                pump.fun <IExt size={13} />
              </a>
            )}
            <a className="x-link" href={xUrl} target="_blank" rel="noopener noreferrer" aria-label={`${BRAND} on X (${xHandle})`}>
              <IXLogo size={15} />
              <span>{xHandle}</span>
            </a>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
