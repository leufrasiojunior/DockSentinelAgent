import {
  BadRequestException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export const AGENT_ROTATION_STATES = [
  "unpaired",
  "paired",
  "pending_rotation",
  "ready_to_complete",
] as const

export type AgentRotationState = (typeof AGENT_ROTATION_STATES)[number]

type AuthState = {
  rotationState: AgentRotationState
  activeCredential: string | null
  pendingBootstrapToken: string | null
}

type StoredAuthState = {
  version: 1
  rotationState: AgentRotationState
  activeCredentialEnc: string | null
  pendingBootstrapTokenEnc: string | null
  updatedAt: string
}

@Injectable()
export class AgentAuthStateService implements OnModuleInit {
  private readonly stateDir =
    process.env.DOCKSENTINEL_AGENT_STATE_DIR?.trim() || "/var/lib/docksentinel-agent"
  private readonly keyFile = join(this.stateDir, "auth.key")
  private readonly stateFile = join(this.stateDir, "auth-state.json")
  private key: Buffer | null = null
  private state: AuthState = {
    rotationState: "unpaired",
    activeCredential: null,
    pendingBootstrapToken: null,
  }
  private loadPromise: Promise<void> | null = null
  private saveQueue = Promise.resolve()

  async onModuleInit() {
    await this.ensureLoaded()
  }

  async getRotationState() {
    await this.ensureLoaded()
    return this.state.rotationState
  }

  async getActiveCredential() {
    await this.ensureLoaded()
    return this.state.activeCredential
  }

  async getExpectedTokenForPath(path: string) {
    await this.ensureLoaded()
    if (path.includes("/agent/v1/setup/complete")) {
      return this.state.pendingBootstrapToken
    }
    return this.state.activeCredential
  }

  async enterPendingRotation() {
    await this.ensureLoaded()
    if (!this.state.activeCredential) {
      throw new BadRequestException("Agent does not have an active credential")
    }

    this.state.pendingBootstrapToken = null
    this.state.rotationState = "pending_rotation"
    await this.persist()
    return this.state.rotationState
  }

  async saveBootstrapToken(token: string) {
    await this.ensureLoaded()
    const value = token.trim()
    if (!value) {
      throw new BadRequestException("Token is required")
    }
    if (this.state.rotationState === "paired") {
      throw new UnauthorizedException("Setup UI is not available while the agent is paired")
    }

    this.state.pendingBootstrapToken = value
    this.state.rotationState = "ready_to_complete"
    await this.persist()
    return this.state.rotationState
  }

  async completeRotation(credential: string) {
    await this.ensureLoaded()
    if (!this.state.pendingBootstrapToken) {
      throw new UnauthorizedException("There is no bootstrap token waiting to be completed")
    }

    const nextCredential = credential.trim()
    if (!nextCredential) {
      throw new BadRequestException("credential is required")
    }

    this.state.activeCredential = nextCredential
    this.state.pendingBootstrapToken = null
    this.state.rotationState = "paired"
    await this.persist()
    return this.state.rotationState
  }

  async getStatus() {
    const state = await this.getRotationState()
    return { state }
  }

  private async ensureLoaded() {
    if (!this.loadPromise) {
      this.loadPromise = this.load()
    }
    await this.loadPromise
  }

  private async load() {
    await mkdir(this.stateDir, { recursive: true })
    this.key = await this.loadOrCreateKey()
    this.state = await this.loadStateFile()

    if (this.state.activeCredential && this.state.rotationState === "unpaired") {
      this.state.rotationState = "paired"
      await this.persist()
    }
  }

  private async loadOrCreateKey() {
    try {
      const existing = await readFile(this.keyFile, "utf8")
      const key = Buffer.from(existing.trim(), "base64")
      if (key.length === 32) return key
    } catch {
      // ignore and create below
    }

    await mkdir(dirname(this.keyFile), { recursive: true })
    const key = randomBytes(32)
    await writeFile(this.keyFile, key.toString("base64"), { mode: 0o600 })
    return key
  }

  private async loadStateFile(): Promise<AuthState> {
    try {
      const raw = await readFile(this.stateFile, "utf8")
      const parsed = JSON.parse(raw) as StoredAuthState
      return {
        rotationState: this.normalizeState(parsed.rotationState),
        activeCredential: parsed.activeCredentialEnc
          ? this.decrypt(parsed.activeCredentialEnc)
          : null,
        pendingBootstrapToken: parsed.pendingBootstrapTokenEnc
          ? this.decrypt(parsed.pendingBootstrapTokenEnc)
          : null,
      }
    } catch {
      return {
        rotationState: "unpaired",
        activeCredential: null,
        pendingBootstrapToken: null,
      }
    }
  }

  private async persist() {
    this.saveQueue = this.saveQueue.then(async () => {
      const payload: StoredAuthState = {
        version: 1,
        rotationState: this.state.rotationState,
        activeCredentialEnc: this.state.activeCredential
          ? this.encrypt(this.state.activeCredential)
          : null,
        pendingBootstrapTokenEnc: this.state.pendingBootstrapToken
          ? this.encrypt(this.state.pendingBootstrapToken)
          : null,
        updatedAt: new Date().toISOString(),
      }
      const tempFile = `${this.stateFile}.tmp`
      await writeFile(tempFile, JSON.stringify(payload, null, 2), { mode: 0o600 })
      await rename(tempFile, this.stateFile)
    })

    await this.saveQueue
  }

  private normalizeState(value?: string | null): AgentRotationState {
    if (value && AGENT_ROTATION_STATES.includes(value as AgentRotationState)) {
      return value as AgentRotationState
    }
    return "unpaired"
  }

  private encrypt(value: string) {
    if (!this.key) {
      throw new Error("Agent auth key was not initialized")
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`
  }

  private decrypt(payload: string) {
    if (!this.key) {
      throw new Error("Agent auth key was not initialized")
    }
    const [version, ivB64, tagB64, dataB64] = payload.split(":")
    if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
      throw new Error("Invalid auth state payload")
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivB64, "base64"),
    )
    decipher.setAuthTag(Buffer.from(tagB64, "base64"))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  }
}
