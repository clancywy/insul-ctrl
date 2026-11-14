import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const HOLD_MS = 2000;

// Confirmation happens while held. Releasing never sends a command.
export default function HoldActionButton({ cancelKey, disabled=false, ...props }) {
  // Remount the gesture when its meaning or eligibility changes; no old hold carries over.
  return <HoldGesture key={`${cancelKey}:${disabled}`} disabled={disabled} {...props} />;
}

function HoldGesture({ label, onConfirm, disabled, statusText, className, children }) {
  const buttonRef = useRef(null);
  const fillRef = useRef(null);
  const active = useRef(null);
  const actionRef = useRef(onConfirm);
  const frameRef = useRef(0);
  const [holding, setHolding] = useState(false);
  const hintId = useId();

  const cancel = useCallback((updateView=true) => {
    const hold = active.current;
    active.current = null;
    cancelAnimationFrame(frameRef.current);
    if (fillRef.current) fillRef.current.style.transform = 'scaleX(0)';
    if (hold?.pointerId !== undefined && buttonRef.current?.hasPointerCapture(hold.pointerId)) {
      buttonRef.current.releasePointerCapture(hold.pointerId);
    }
    if (updateView && hold) setHolding(false);
  }, []);

  useLayoutEffect(() => { actionRef.current = onConfirm; }, [onConfirm]);
  useLayoutEffect(() => () => cancel(false), [cancel]);
  useEffect(() => {
    const stop = () => cancel();
    const hidden = () => { if (document.hidden) cancel(); };
    const anotherPointer = event => {
      const hold = active.current;
      if (hold && hold.pointerId !== event.pointerId) cancel();
    };
    window.addEventListener('blur', stop);
    window.addEventListener('pagehide', stop);
    window.addEventListener('pointerdown', anotherPointer, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancel(false);
      window.removeEventListener('blur', stop);
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('pointerdown', anotherPointer, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [cancel]);

  const begin = input => {
    if (disabled || active.current || document.hidden) return;
    const hold = { ...input, started:performance.now(), fired:false };
    active.current = hold;
    setHolding(true);
    const tick = () => {
      if (active.current !== hold || hold.fired) return;
      if (document.hidden || !buttonRef.current?.isConnected || buttonRef.current.disabled) { cancel(); return; }
      const progress = Math.min(1, (performance.now() - hold.started) / HOLD_MS);
      fillRef.current.style.transform = `scaleX(${progress})`;
      if (progress >= 1) {
        hold.fired = true;
        setHolding(false);
        actionRef.current();
      } else frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const pointerDown = event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll:true});
    event.currentTarget.setPointerCapture(event.pointerId);
    begin({pointerId:event.pointerId});
  };
  const pointerMove = event => {
    if (active.current?.pointerId !== event.pointerId) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) cancel();
  };
  const pointerEnd = event => {
    if (active.current?.pointerId === event.pointerId) cancel();
  };

  return <button ref={buttonRef} type="button" aria-label={label} aria-describedby={hintId}
    disabled={disabled} className={`hold-action ${className}`} data-holding={holding ? 'true' : 'false'}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd}
    onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd}
    onBlur={() => cancel()} onContextMenu={event => event.preventDefault()}
    onClick={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) begin({key:event.key});
    }}
    onKeyUp={event => {
      if (active.current?.key !== event.key) return;
      event.preventDefault();
      cancel();
    }}>
    <span ref={fillRef} className="hold-action-fill" aria-hidden="true" />
    <span className="hold-action-content">
      <span className="hold-action-label">{children}</span>
      <span id={hintId} className="hold-action-hint">{holding ? '松手取消' : statusText || '按住2秒'}</span>
    </span>
  </button>;
}
