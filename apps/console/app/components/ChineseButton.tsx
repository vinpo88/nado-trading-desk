"use client";

import { forwardRef } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import type { ButtonProps } from "@cloudflare/kumo";

/** Kumo's built-in loading label is English; retain its disabled behavior with a Chinese spinner. */
export const ChineseButton = forwardRef<HTMLButtonElement, ButtonProps>(function ChineseButton(props, ref) {
  return <Button
    {...props}
    ref={ref}
    loading={false}
    disabled={props.disabled || props.loading}
    aria-busy={props.loading || undefined}
    icon={props.loading ? <Loader size={props.size === "lg" ? 16 : 14} aria-label="正在加载" /> : props.icon}
  />;
});
