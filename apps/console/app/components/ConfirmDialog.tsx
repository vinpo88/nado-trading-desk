"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Banner, Input, LayerDialog } from "@cloudflare/kumo";
import { WarningIcon } from "@phosphor-icons/react";

/** A guarded typed-confirm before an irreversible action — Kumo's own typed-confirm pattern
 *  (LayerDialog.Alert + a "Type X to confirm" Input + a destructive primary action; the shape of
 *  Kumo's delete-resource block). Kept MOUNTED and driven by `open` (Kumo design rule: never
 *  conditionally render dialogs). Alert semantics: Escape or the automatic "Cancel" dismisses; the
 *  backdrop does not. `danger` renders a real-funds warning as one loud error Banner. */
export function ConfirmDialog({ open, title, body, danger, confirmWord = "执行", onConfirm, onCancel }: {
  open: boolean;
  title: string;
  body: ReactNode;
  danger?: ReactNode;
  confirmWord?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => { if (!open) setText(""); }, [open]);

  return (
    <LayerDialog.Alert open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <LayerDialog.Content size="sm" closeLabel="关闭">
        <LayerDialog.Title>{title}</LayerDialog.Title>
        <LayerDialog.Body>
          <div className="flex flex-col gap-4">
            {danger && <Banner variant="error" size="sm" icon={<WarningIcon weight="fill" />} description={danger} />}
            <div className="text-kumo-subtle">{body}</div>
            <Input
              label={<>输入 <strong className="font-medium text-kumo-default">{confirmWord}</strong> 以确认</>}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={confirmWord}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
            />
          </div>
        </LayerDialog.Body>
        <LayerDialog.Actions dismissLabel="取消">
          <LayerDialog.Actions.Primary variant="destructive" disabled={text.trim() !== confirmWord} onClick={onConfirm}>
            确认并执行
          </LayerDialog.Actions.Primary>
        </LayerDialog.Actions>
      </LayerDialog.Content>
    </LayerDialog.Alert>
  );
}
