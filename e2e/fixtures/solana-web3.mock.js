/* Explicit browser-only Solana test double. It never contacts an RPC node. */
(function installForesightSolanaWeb3Mock(global) {
  class PublicKey {
    constructor(value) { this.value = String(value) }
    toString() { return this.value }
  }
  class TransactionInstruction {
    constructor(fields) { Object.assign(this, fields) }
  }
  class Transaction {
    constructor() { this.instructions = [] }
    add(instruction) { this.instructions.push(instruction); return this }
  }
  class Connection {
    constructor(endpoint, commitment) {
      this.endpoint = endpoint
      this.commitment = commitment
      global.__FORESIGHT_SOLANA_RPC_MOCK_USED__ = true
    }
    async getBalance() { return 2_000_000_000 }
    async getLatestBlockhash() { return { blockhash: 'foresight-e2e-blockhash' } }
    async confirmTransaction(signature) {
      global.__FORESIGHT_SOLANA_CONFIRMED_SIGNATURE__ = String(signature)
      return { value: { err: null } }
    }
    async getTransaction() { return { slot: 424242, blockTime: 1_784_487_600 } }
    async sendRawTransaction() { return 'foresight-e2e-raw-signature' }
  }
  global.solanaWeb3 = { Connection, PublicKey, Transaction, TransactionInstruction }
  global.__FORESIGHT_SOLANA_WEB3_MOCK__ = true
})(window)
