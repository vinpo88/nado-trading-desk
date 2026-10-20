"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { activeChainId, setActiveChainId, networkForChainId } from "../lib/chainEnv";
import type { NetworkConfig } from "../lib/chainEnv";
import { bulk } from "../lib/bulk";

/** The cookie keeps browser and server requests on the same network. Switching reloads
 *  every network-bound module together and requires unlocking the encrypted vault again. */
interface NetworkCtx { chainId: number; net: NetworkConfig; setChain: (id: number) => void }
const Ctx = createContext<NetworkCtx | null>(null);

export function useNetwork(): NetworkCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useNetwork must be used within <NetworkProvider>");
  return c;
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [chainId] = useState<number>(() => activeChainId());
  // Sync the selected network's theme after unlock; layout.tsx also seeds it during SSR.
  useEffect(() => {
    const net = networkForChainId(chainId);
    if (net && typeof document !== "undefined") document.documentElement.dataset.net = net.networkName;
  }, [chainId]);
  const setChain = useCallback((id: number) => {
    if (id === activeChainId() || !networkForChainId(id)) return;
    // Recreate all network-bound modules, reads, sockets and signer contexts together.
    // The encrypted vault stays in IndexedDB; the user unlocks it again after reload.
    bulk.halt();
    setActiveChainId(id);
    window.location.reload();
  }, []);
  return <Ctx.Provider value={{ chainId, net: networkForChainId(chainId)!, setChain }}>{children}</Ctx.Provider>;
}
