"use client";

import { Button, Empty, Grid, LayerCard, LayerDialog, Table, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, ReceiptIcon } from "@phosphor-icons/react";
import { rollup, toCsv, toJson } from "@farm/ui";
import type { AccountingRecord, Rollup } from "@farm/ui";

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A KPI tile built from Kumo pieces (Kumo ships no stat primitive): a simple LayerCard with a
 *  secondary caption and a tabular value. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard className="flex flex-col gap-1 p-3">
      <Text variant="secondary" size="xs">{label}</Text>
      <span className="font-semibold tabular-nums">{value}</span>
    </LayerCard>
  );
}

/** One rollup as a Kumo Table (compact sticky header) inside a height-capped scroll region. */
function RollupTable({ title, rows, keyLabel }: { title: string; rows: Rollup[]; keyLabel: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-kumo-subtle">{title}</span>
      <LayerCard className="p-0">
        <div className="max-h-56 overflow-y-auto">
          <Table className="tabular-nums">
            <Table.Header variant="compact" sticky>
              <Table.Row>
                <Table.Head>{keyLabel}</Table.Head>
                <Table.Head>订单数</Table.Head>
                <Table.Head>成交额</Table.Head>
                <Table.Head>买入</Table.Head>
                <Table.Head>卖出</Table.Head>
                <Table.Head>手续费</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.slice(0, 50).map((r) => (
                <Table.Row key={r.key}>
                  <Table.Cell className="font-mono">{r.key === "LIVE" ? "联网" : r.key === "LOCAL" ? "本地" : r.key}</Table.Cell>
                  <Table.Cell>{r.orders}</Table.Cell>
                  <Table.Cell>{r.volume.toFixed(2)}</Table.Cell>
                  <Table.Cell>{r.buys}</Table.Cell>
                  <Table.Cell>{r.sells}</Table.Cell>
                  <Table.Cell>{r.fees.toFixed(4)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {rows.length > 50 && (
          <div className="px-3 py-2 text-center">
            <Text variant="secondary" size="xs">另有 {rows.length - 50} 条记录（导出文件包含全部记录）</Text>
          </div>
        )}
      </LayerCard>
    </div>
  );
}

/** The fleet accounting ledger as a Kumo LayerDialog: kept mounted and driven by `open` (Kumo
 *  dialog-rendering rule); outside click / Escape / the automatic X close it; only the body scrolls. */
export function AccountingView({ open, records, onClose }: { open: boolean; records: AccountingRecord[]; onClose: () => void }) {
  // `records` (bulk.activity) is mutated in place, so compute fresh each open
  // rather than memoizing on a stable reference.
  const report = open ? rollup(records) : null;
  const t = report?.totals;
  return (
    <LayerDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <LayerDialog.Content size="lg">
        <LayerDialog.Title>交易账目</LayerDialog.Title>
        <LayerDialog.Description>{records.length} 笔订单</LayerDialog.Description>
        <LayerDialog.Body>
          {report && t && (
            // pt-1: Body is a scroll container with no top padding, which clipped the stat cards' ring.
            <div className="flex flex-col gap-4 pt-1">
              <Grid variant="4up" gap="sm">
                <Stat label="订单数" value={String(t.orders)} />
                <Stat label="成交额" value={t.volume.toFixed(2)} />
                <Stat label="买入 / 卖出" value={`${t.buys} / ${t.sells}`} />
                <Stat label="手续费" value={t.fees.toFixed(4)} />
              </Grid>
              {records.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<ReceiptIcon size={32} className="text-kumo-inactive" />}
                  title="暂无交易记录"
                  description="执行批量操作后，相关记录会显示在这里。"
                />
              ) : (
                <>
                  <RollupTable title="按分组汇总" rows={report.byCohort} keyLabel="分组" />
                  <RollupTable title="按钱包汇总" rows={report.byWallet} keyLabel="钱包" />
                </>
              )}
              <div className="flex gap-2">
                <Button icon={DownloadSimpleIcon} onClick={() => download("fleet-accounting.csv", toCsv(report), "text/csv")} disabled={records.length === 0}>导出 CSV</Button>
                <Button icon={DownloadSimpleIcon} onClick={() => download("fleet-accounting.json", toJson(report), "application/json")} disabled={records.length === 0}>导出 JSON</Button>
              </div>
            </div>
          )}
        </LayerDialog.Body>
      </LayerDialog.Content>
    </LayerDialog.Root>
  );
}
