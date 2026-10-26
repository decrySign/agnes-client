import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

/**
 * 输入框随内容长高：编辑时最多 maxLines 行，超出内部滚动；失焦后收回一行，内容不丢。
 * 失焦稍等一下再收，免得点发送键时输入框先缩、按钮跑位导致点空。
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxLines = 5) {
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 24;
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    if (!focused) {
      el.style.height = `${Math.ceil(line + pad)}px`;
      el.style.overflowY = "hidden";
      el.scrollTop = 0;
      return;
    }
    el.style.height = "0px";
    const max = line * maxLines + pad;
    const full = el.scrollHeight;
    el.style.height = `${Math.ceil(Math.min(full, max))}px`;
    el.style.overflowY = full > max + 1 ? "auto" : "hidden";
  }, [ref, value, focused, maxLines]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return {
    focused,
    onFocus: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setFocused(true);
    },
    onBlur: (_event?: FocusEvent<HTMLTextAreaElement>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (ref.current && document.activeElement === ref.current) return;
        setFocused(false);
      }, 150);
    },
  };
}
