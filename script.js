const CONTRACT_ADDRESS = "0xA52bd32fdF1B6A8850a9F1D57b6D9C73F935Ea69";
const CONTRACT_ABI = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function mint(address to, uint256 amount)",
  "function redeem(uint256 amount)",
  "function pause()",
  "function unpause()",
  "event PointsGiven(address indexed to, uint256 amount)",
  "event PointsRedeemed(address indexed customer, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
// Redeeming this many points or more shows a "reward unlocked" banner (UI-only, no on-chain logic)
const REWARD_THRESHOLD = 5;

const iface = new ethers.Interface(CONTRACT_ABI);

function loyaltyApp() {
  return {
    connected: false,
    account: null,
    isOwner: false,
    paused: false,
    balance: "0",
    mintTo: "",
    mintAmount: "",
    redeemAmount: "",
    minting: false,
    pausing: false,
    redeeming: false,
    showReward: false,
    mintStatus: { type: "", msg: "" },
    pauseStatus: { type: "", msg: "" },
    redeemStatus: { type: "", msg: "" },
    globalError: "",
    hasInjectedWallet: false,
    demoMode: false,

    async init() {
      this.hasInjectedWallet = Boolean(window.ethereum);
      if (!window.ethereum) {
        this.globalError = "No wallet detected. Open this page in a real browser (Chrome/Edge/Firefox/Brave) with the MetaMask extension installed — it will not work inside VS Code's Live Preview or any embedded webview.";
        return;
      }
      // Reconnect silently if already authorized, and react to account/chain changes without refresh
      window.ethereum.on("accountsChanged", () => this.connect());
      window.ethereum.on("chainChanged", () => window.location.reload());

      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts.length > 0) await this.connect();
    },

    async connect() {
      this.globalError = "";
      if (!window.ethereum) {
        this.globalError = "No wallet detected. Open this page in a real browser (Chrome/Edge/Firefox/Brave) with the MetaMask extension installed — it will not work inside VS Code's Live Preview or any embedded webview.";
        return this.startDemo();
      }
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        if (!accounts.length) return this.disconnect();

        this.account = accounts[0];
        this.connected = true;
        this.demoMode = false;

        await this.loadState();
      } catch (err) {
        console.error(err);
        this.globalError = err?.message || "Failed to connect wallet. Check the browser console for details.";
        this.disconnect();
      }
    },

    startDemo() {
      this.connected = true;
      this.demoMode = true;
      this.account = "0x0000000000000000000000000000000000000000";
      this.isOwner = false;
      this.paused = false;
      this.balance = "0";
      this.globalError = "";
    },

    disconnect() {
      this.connected = false;
      this.account = null;
      this.isOwner = false;
      this.balance = "0";
      this.demoMode = false;
    },

    // ---- Raw JSON-RPC helpers (bypass ethers Provider/Contract/Signer classes) ----
    async ethCall(fnName, args = []) {
      const data = iface.encodeFunctionData(fnName, args);
      const result = await window.ethereum.request({
        method: "eth_call",
        params: [{ to: CONTRACT_ADDRESS, data }, "latest"]
      });
      return iface.decodeFunctionResult(fnName, result);
    },

    async sendTx(fnName, args = []) {
      const data = iface.encodeFunctionData(fnName, args);
      const txHash = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: this.account, to: CONTRACT_ADDRESS, data }]
      });
      return this.waitForReceipt(txHash);
    },

    async waitForReceipt(txHash) {
      for (;;) {
        const receipt = await window.ethereum.request({
          method: "eth_getTransactionReceipt",
          params: [txHash]
        });
        if (receipt) {
          if (receipt.status === "0x0") throw new Error("Transaction reverted.");
          return receipt;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    },

    async loadState() {
      const [ownerResult, pausedResult] = await Promise.all([
        this.ethCall("owner"),
        this.ethCall("paused")
      ]);
      this.isOwner = ownerResult[0].toLowerCase() === this.account.toLowerCase();
      this.paused = pausedResult[0];

      if (!this.isOwner) {
        const balResult = await this.ethCall("balanceOf", [this.account]);
        this.balance = balResult[0].toString();
      }
    },

    async mintPoints() {
      this.mintStatus = { type: "pending", msg: "" };
      this.minting = true;
      try {
        this.mintStatus = { type: "pending", msg: "Transaction sent, waiting for confirmation..." };
        await this.sendTx("mint", [this.mintTo, this.mintAmount]);
        this.mintStatus = { type: "ok", msg: `Gave ${this.mintAmount} points to ${this.shortAddr(this.mintTo)}` };
        this.mintTo = "";
        this.mintAmount = "";
      } catch (err) {
        this.mintStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.minting = false;
      }
    },

    async togglePause() {
      this.pauseStatus = { type: "pending", msg: "" };
      this.pausing = true;
      try {
        await this.sendTx(this.paused ? "unpause" : "pause");
        this.paused = !this.paused;
        this.pauseStatus = { type: "ok", msg: this.paused ? "Contract paused." : "Contract unpaused." };
      } catch (err) {
        this.pauseStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.pausing = false;
      }
    },

    async redeemPoints() {
      this.redeemStatus = { type: "pending", msg: "" };
      this.showReward = false;
      this.redeeming = true;
      try {
        const amount = this.redeemAmount;
        this.redeemStatus = { type: "pending", msg: "Transaction sent, waiting for confirmation..." };
        await this.sendTx("redeem", [amount]);
        const balResult = await this.ethCall("balanceOf", [this.account]);
        this.balance = balResult[0].toString();
        this.redeemStatus = { type: "ok", msg: `Redeemed ${amount} points.` };
        if (Number(amount) >= REWARD_THRESHOLD) this.showReward = true;
        this.redeemAmount = "";
      } catch (err) {
        this.redeemStatus = { type: "err", msg: this.parseError(err) };
      } finally {
        this.redeeming = false;
      }
    },

    shortAddr(a) {
      if (!a) return "";
      return a.slice(0, 6) + "..." + a.slice(-4);
    },

    parseError(err) {
      return err?.shortMessage || err?.reason || err?.message || "Transaction failed.";
    }
  };
}