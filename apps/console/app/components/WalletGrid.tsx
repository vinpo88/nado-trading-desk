"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WalletVM } from "@farm/ui";
import { WalletCard } from "./WalletCard";

// The horizontal card wall: rows fill the viewport height, columns extend rightward.
// Virtualized by COLUMN — only the visible columns (+overscan) mount, so ~1000 cards
// scroll smoothly. One wallet = one card.
const CARD_H = 168;
const CARD_W = 230;
const GAP = 12;
const PAD = 16;

export function WalletGrid({ wallets, selectedId, onSelect, offline = false, onVisibleWalletsChange }: {
  wallets: WalletVM[];
  selectedId?: string;
  onSelect: (w: WalletVM) => void;
  offline?: boolean;
  onVisibleWalletsChange?: (ids: string[]) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState(4);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight - 2 * PAD;
      setRows(Math.max(1, Math.floor((h + GAP) / (CARD_H + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = Math.max(1, Math.ceil(wallets.length / rows));
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_W + GAP,
    overscan: 3,
  });
  const visibleKey = colVirtualizer.getVirtualItems()
    .flatMap((col) => wallets.slice(col.index * rows, (col.index + 1) * rows).map((wallet) => wallet.id)).join(",");
  useEffect(() => {
    onVisibleWalletsChange?.(visibleKey ? visibleKey.split(",") : []);
  }, [visibleKey, onVisibleWalletsChange]);
  useEffect(() => () => { onVisibleWalletsChange?.([]); }, [onVisibleWalletsChange]);

  return (
    <div ref={scrollRef} data-testid="wallet-grid" className="h-full overflow-x-auto overflow-y-hidden" style={{ padding: PAD }}>
      <div style={{ width: colVirtualizer.getTotalSize(), height: "100%", position: "relative" }}>
        {colVirtualizer.getVirtualItems().map((col) => {
          const start = col.index * rows;
          const slice = wallets.slice(start, start + rows);
          return (
            <div
              key={col.key}
              style={{ position: "absolute", top: 0, left: col.start, width: CARD_W, height: "100%", display: "flex", flexDirection: "column", gap: GAP }}
            >
              {slice.map((w) => (
                <div key={w.id} style={{ height: CARD_H, flex: "0 0 auto" }}>
                  <WalletCard wallet={w} selected={w.id === selectedId} onSelect={onSelect} offline={offline} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
