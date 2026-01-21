import z from "zod"
import path from "path"
import fs from "fs/promises"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { Global } from "../global"

export namespace RemoteSkill {
  const log = Log.create({ service: "remote-skill" })

  /**
   * Get the namespaced identifier for a remote skill.
   * Format: <domain>/<skill-name>
   *
   * @param domain - The domain (e.g., "cloudflare.com")
   * @param skill - The skill name (e.g., "wrangler")
   * @returns The namespaced identifier (e.g., "cloudflare.com/wrangler")
   */
  export function namespace(domain: string, skill: string): string {
    return `${domain}/${skill}`
  }

  /**
   * Parse a namespaced skill identifier into domain and skill parts.
   * Returns undefined if the identifier is not a valid namespace format.
   *
   * @param id - The namespaced identifier (e.g., "cloudflare.com/wrangler")
   * @returns Object with domain and skill, or undefined if invalid
   */
  export function parseNamespace(id: string): { domain: string; skill: string } | undefined {
    // Must have at least one slash to be a namespaced skill
    const firstSlash = id.indexOf("/")
    if (firstSlash <= 0) return undefined

    const domain = id.substring(0, firstSlash)
    const skill = id.substring(firstSlash + 1)

    // Domain must have at least a dot or colon (for ports)
    // This distinguishes "cloudflare.com/wrangler" from "category/skill"
    if (!domain.includes(".") && !domain.includes(":")) return undefined

    // Skill must not be empty
    if (!skill) return undefined

    return { domain, skill }
  }

  /**
   * Check if an identifier is a namespaced remote skill.
   *
   * @param id - The identifier to check
   * @returns True if the identifier is in namespace format
   */
  export function isNamespaced(id: string): boolean {
    return parseNamespace(id) !== undefined
  }

  /**
   * Get a cached skill by its namespaced identifier.
   * Returns the skill content and directory if cached, undefined otherwise.
   *
   * @param id - The namespaced identifier (e.g., "cloudflare.com/wrangler")
   * @returns The cached skill info or undefined if not cached
   */
  export async function getCached(
    id: string,
  ): Promise<{ content: string; dir: string; domain: string; skill: string } | undefined> {
    const parsed = parseNamespace(id)
    if (!parsed) return undefined

    const cached = await isCached(parsed.domain, parsed.skill)
    if (!cached) return undefined

    const dir = getCachePath(parsed.domain, parsed.skill)
    const file = Bun.file(path.join(dir, "SKILL.md"))
    if (!(await file.exists())) return undefined

    const content = await file.text()
    return {
      content,
      dir,
      domain: parsed.domain,
      skill: parsed.skill,
    }
  }

  /**
   * List all cached remote skills with their namespaced identifiers.
   *
   * @returns Array of cached skill info with namespaced ids
   */
  export async function listCached(): Promise<Array<{ id: string; domain: string; skill: string; dir: string }>> {
    const results: Array<{ id: string; domain: string; skill: string; dir: string }> = []
    const basePath = Global.Path.remoteSkills

    // Check if the remote skills directory exists
    const stat = await fs.stat(basePath).catch(() => null)
    if (!stat?.isDirectory()) return results

    try {
      const domains = await fs.readdir(basePath)
      for (const domain of domains) {
        const domainPath = path.join(basePath, domain)
        const stat = await fs.stat(domainPath).catch(() => null)
        if (!stat?.isDirectory()) continue

        const skills = await fs.readdir(domainPath)
        for (const skill of skills) {
          const skillPath = path.join(domainPath, skill)
          const skillStat = await fs.stat(skillPath).catch(() => null)
          if (!skillStat?.isDirectory()) continue

          // Check if this is a valid cached skill (has SKILL.md)
          const hasSkill = await Bun.file(path.join(skillPath, "SKILL.md")).exists()
          if (!hasSkill) continue

          results.push({
            id: namespace(domain, skill),
            domain,
            skill,
            dir: skillPath,
          })
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
      return results
    }

    return results
  }

  /**
   * Schema for a single skill entry in the index.json
   */
  export const SkillEntry = z.object({
    name: z.string(),
    description: z.string(),
    files: z.array(z.string()).optional(),
  })
  export type SkillEntry = z.infer<typeof SkillEntry>

  /**
   * Schema for the index.json file
   */
  export const Index = z.object({
    skills: z.array(z.unknown()),
  })
  export type Index = z.infer<typeof Index>

  /**
   * Result of parsing a skill entry - either valid or invalid with reason
   */
  export type ParsedSkillEntry = { valid: true; skill: SkillEntry } | { valid: false; reason: string; raw: unknown }

  /**
   * Result of fetching and parsing an index
   */
  export type FetchIndexResult = {
    skills: ParsedSkillEntry[]
  }

  export const FetchError = NamedError.create(
    "RemoteSkillFetchError",
    z.object({
      domain: z.string(),
      status: z.number().optional(),
      message: z.string(),
    }),
  )

  export const ParseError = NamedError.create(
    "RemoteSkillParseError",
    z.object({
      domain: z.string(),
      message: z.string(),
    }),
  )

  /**
   * Schema for cache metadata stored in _metadata.json
   */
  export const Metadata = z.object({
    etag: z.string().optional(),
    expires: z.number().optional(),
    fetched: z.number(),
  })
  export type Metadata = z.infer<typeof Metadata>

  const METADATA_FILE = "_metadata.json"
  const SKILL_FILE = "SKILL.md"

  export const DownloadError = NamedError.create(
    "RemoteSkillDownloadError",
    z.object({
      domain: z.string(),
      skill: z.string(),
      file: z.string().optional(),
      status: z.number().optional(),
      message: z.string(),
    }),
  )

  /**
   * Get the cache path for a skill.
   *
   * @param domain - The domain (e.g., "example.com" or "example.com:8080")
   * @param skill - The skill name
   * @returns The full path to the skill cache directory
   */
  export function getCachePath(domain: string, skill: string): string {
    return path.join(Global.Path.remoteSkills, domain, skill)
  }

  /**
   * Check if a skill exists in the cache.
   *
   * @param domain - The domain
   * @param skill - The skill name
   * @returns True if the skill is cached (has _metadata.json)
   */
  export async function isCached(domain: string, skill: string): Promise<boolean> {
    const metadata = path.join(getCachePath(domain, skill), METADATA_FILE)
    const file = Bun.file(metadata)
    return file.exists()
  }

  /**
   * Check if a cached skill is stale (past its expiry time).
   *
   * @param domain - The domain
   * @param skill - The skill name
   * @returns True if the skill is stale or not cached
   */
  export async function isStale(domain: string, skill: string): Promise<boolean> {
    const metadata = path.join(getCachePath(domain, skill), METADATA_FILE)
    const file = Bun.file(metadata)

    if (!(await file.exists())) {
      return true
    }

    try {
      const content = await file.json()
      const parsed = Metadata.safeParse(content)
      if (!parsed.success) {
        log.warn("invalid cache metadata", { domain, skill })
        return true
      }

      // If no expires time set, consider it stale
      if (parsed.data.expires === undefined) {
        return true
      }

      return Date.now() > parsed.data.expires
    } catch {
      return true
    }
  }

  /**
   * Read the metadata for a cached skill.
   *
   * @param domain - The domain
   * @param skill - The skill name
   * @returns The metadata or undefined if not cached or invalid
   */
  export async function getMetadata(domain: string, skill: string): Promise<Metadata | undefined> {
    const metadata = path.join(getCachePath(domain, skill), METADATA_FILE)
    const file = Bun.file(metadata)

    if (!(await file.exists())) {
      return undefined
    }

    try {
      const content = await file.json()
      const parsed = Metadata.safeParse(content)
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Normalize a domain to ensure it uses HTTPS.
   * - Strips any existing protocol
   * - Returns the full URL to the well-known endpoint
   */
  function normalizeUrl(domain: string): string {
    // Remove any protocol prefix
    let cleaned = domain.replace(/^https?:\/\//, "")
    // Remove trailing slash
    cleaned = cleaned.replace(/\/$/, "")
    // Always use HTTPS
    return `https://${cleaned}/.well-known/skills/index.json`
  }

  /**
   * Fetch and parse the skills index from a domain's .well-known/skills/index.json
   *
   * @param domain - The domain to fetch from (e.g., "example.com" or "example.com:8080")
   * @returns Parsed index with valid/invalid markers for each entry
   * @throws FetchError for network errors or non-200 responses
   * @throws ParseError for malformed JSON
   */
  export async function fetchIndex(domain: string): Promise<FetchIndexResult> {
    const url = normalizeUrl(domain)
    log.info("fetching remote skills index", { domain, url })

    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
        },
      })
    } catch (err) {
      throw new FetchError({
        domain,
        message: `Failed to fetch skills index: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    if (response.status === 404) {
      throw new FetchError({
        domain,
        status: 404,
        message: `No skills index found at ${url}`,
      })
    }

    if (!response.ok) {
      throw new FetchError({
        domain,
        status: response.status,
        message: `HTTP ${response.status}: ${response.statusText}`,
      })
    }

    let json: unknown
    try {
      json = await response.json()
    } catch (err) {
      throw new ParseError({
        domain,
        message: `Invalid JSON in skills index: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    // Parse the index structure
    const parsed = Index.safeParse(json)
    if (!parsed.success) {
      throw new ParseError({
        domain,
        message: `Invalid index structure: expected object with 'skills' array`,
      })
    }

    // Parse each skill entry individually
    const skills: ParsedSkillEntry[] = parsed.data.skills.map((raw) => {
      const result = SkillEntry.safeParse(raw)
      if (!result.success) {
        const issues = result.error.issues.map((i) => i.message).join(", ")
        return { valid: false as const, reason: issues, raw }
      }

      // Validate that files array exists and is not empty
      const skill = result.data
      if (!skill.files) {
        return { valid: false as const, reason: "missing files array", raw }
      }
      if (skill.files.length === 0) {
        return { valid: false as const, reason: "empty files array", raw }
      }

      return { valid: true as const, skill }
    })

    log.info("parsed remote skills index", {
      domain,
      total: skills.length,
      valid: skills.filter((s) => s.valid).length,
      invalid: skills.filter((s) => !s.valid).length,
    })

    return { skills }
  }

  /**
   * Build the base URL for a skill's files.
   * Files are served from /.well-known/skills/<skill-name>/
   */
  function skillBaseUrl(domain: string, skill: string): string {
    let cleaned = domain.replace(/^https?:\/\//, "")
    cleaned = cleaned.replace(/\/$/, "")
    return `https://${cleaned}/.well-known/skills/${skill}`
  }

  /**
   * Parse cache-control header to extract max-age value.
   * Returns the expiry timestamp or undefined if not found.
   */
  function parseCacheControl(header: string | null): number | undefined {
    if (!header) return undefined
    const match = header.match(/max-age=(\d+)/)
    if (!match) return undefined
    const seconds = parseInt(match[1], 10)
    return Date.now() + seconds * 1000
  }

  /**
   * Download a skill and all its files to the cache.
   *
   * @param domain - The domain to download from
   * @param skill - The skill entry to download (must have name and optionally files array)
   * @returns The path to the cached skill directory
   * @throws DownloadError for network errors or non-200 responses
   */
  export async function download(domain: string, skill: SkillEntry): Promise<string> {
    const dir = getCachePath(domain, skill.name)
    const base = skillBaseUrl(domain, skill.name)
    log.info("downloading remote skill", { domain, skill: skill.name, dir })

    // Create the cache directory (overwrites existing)
    await fs.mkdir(dir, { recursive: true })

    // Track cache headers from the SKILL.md response for metadata
    let etag: string | undefined
    let expires: number | undefined

    // Download SKILL.md (required)
    const skillUrl = `${base}/${SKILL_FILE}`
    let response: Response
    try {
      response = await fetch(skillUrl)
    } catch (err) {
      throw new DownloadError({
        domain,
        skill: skill.name,
        file: SKILL_FILE,
        message: `Failed to fetch ${SKILL_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }

    if (!response.ok) {
      throw new DownloadError({
        domain,
        skill: skill.name,
        file: SKILL_FILE,
        status: response.status,
        message: `HTTP ${response.status}: ${response.statusText}`,
      })
    }

    // Extract cache headers from SKILL.md
    etag = response.headers.get("etag") || undefined
    expires = parseCacheControl(response.headers.get("cache-control"))

    const content = await response.text()
    await Bun.write(path.join(dir, SKILL_FILE), content)

    // Download additional files
    const files = skill.files || []
    for (const file of files) {
      const fileUrl = `${base}/${file}`
      const filePath = path.join(dir, file)

      // Ensure parent directory exists (for nested files like scripts/migrate.sh)
      const parent = path.dirname(filePath)
      await fs.mkdir(parent, { recursive: true })

      let fileResponse: Response
      try {
        fileResponse = await fetch(fileUrl)
      } catch (err) {
        throw new DownloadError({
          domain,
          skill: skill.name,
          file,
          message: `Failed to fetch ${file}: ${err instanceof Error ? err.message : String(err)}`,
        })
      }

      if (!fileResponse.ok) {
        throw new DownloadError({
          domain,
          skill: skill.name,
          file,
          status: fileResponse.status,
          message: `HTTP ${fileResponse.status}: ${fileResponse.statusText}`,
        })
      }

      const fileContent = await fileResponse.arrayBuffer()
      await Bun.write(filePath, fileContent)
    }

    // Write metadata
    const metadata: Metadata = {
      etag,
      expires,
      fetched: Date.now(),
    }
    await Bun.write(path.join(dir, METADATA_FILE), JSON.stringify(metadata, null, 2))

    log.info("downloaded remote skill", {
      domain,
      skill: skill.name,
      files: files.length + 1,
      expires: expires ? new Date(expires).toISOString() : undefined,
    })

    return dir
  }

  /**
   * Result of loading a skill
   */
  export type LoadResult = {
    content: string
    dir: string
  }

  export const LoadError = NamedError.create(
    "RemoteSkillLoadError",
    z.object({
      domain: z.string(),
      skill: z.string(),
      message: z.string(),
    }),
  )

  /**
   * Load a skill from cache or network.
   *
   * - If cached and not stale, returns from cache
   * - If cached but stale and network available, refreshes cache
   * - If cached but stale and network unavailable, serves stale silently
   * - If not cached, downloads and caches
   *
   * @param domain - The domain to load from
   * @param skill - The skill entry to load
   * @returns The skill content and cache directory path
   * @throws LoadError if skill cannot be loaded (not cached and network unavailable)
   */
  export async function load(domain: string, skill: SkillEntry): Promise<LoadResult> {
    const dir = getCachePath(domain, skill.name)
    const cached = await isCached(domain, skill.name)
    const stale = await isStale(domain, skill.name)

    log.info("loading remote skill", { domain, skill: skill.name, cached, stale })

    // If cached and not stale, return from cache
    if (cached && !stale) {
      log.info("serving from cache", { domain, skill: skill.name })
      const content = await readSkillContent(dir)
      return { content, dir }
    }

    // If cached but stale, try to refresh
    if (cached && stale) {
      log.info("cache stale, attempting refresh", { domain, skill: skill.name })
      try {
        await download(domain, skill)
        const content = await readSkillContent(dir)
        return { content, dir }
      } catch (err) {
        // Network unavailable, serve stale silently
        log.warn("refresh failed, serving stale", { domain, skill: skill.name, error: err })
        const content = await readSkillContent(dir)
        return { content, dir }
      }
    }

    // Not cached, must download
    log.info("not cached, downloading", { domain, skill: skill.name })
    try {
      await download(domain, skill)
      const content = await readSkillContent(dir)
      return { content, dir }
    } catch (err) {
      throw new LoadError({
        domain,
        skill: skill.name,
        message: `Failed to load skill: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /**
   * Read the SKILL.md content from a cache directory.
   */
  async function readSkillContent(dir: string): Promise<string> {
    const file = Bun.file(path.join(dir, SKILL_FILE))
    return file.text()
  }
}
