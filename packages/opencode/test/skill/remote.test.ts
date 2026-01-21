import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test"
import { RemoteSkill } from "../../src/skill/remote"
import { Global } from "../../src/global"
import path from "path"
import fs from "fs/promises"

describe("RemoteSkill.namespace", () => {
  test("creates namespaced identifier from domain and skill", () => {
    expect(RemoteSkill.namespace("cloudflare.com", "wrangler")).toBe("cloudflare.com/wrangler")
    expect(RemoteSkill.namespace("example.com:8080", "my-skill")).toBe("example.com:8080/my-skill")
  })
})

describe("RemoteSkill.parseNamespace", () => {
  test("parses valid namespaced identifier", () => {
    const result = RemoteSkill.parseNamespace("cloudflare.com/wrangler")
    expect(result).toEqual({ domain: "cloudflare.com", skill: "wrangler" })
  })

  test("parses namespaced identifier with port", () => {
    const result = RemoteSkill.parseNamespace("example.com:8080/my-skill")
    expect(result).toEqual({ domain: "example.com:8080", skill: "my-skill" })
  })

  test("returns undefined for local skill paths without domain", () => {
    // Local skill paths like "category/skill" should not be parsed as namespaced
    expect(RemoteSkill.parseNamespace("category/skill")).toBe(undefined)
    expect(RemoteSkill.parseNamespace("local/my-skill")).toBe(undefined)
  })

  test("returns undefined for simple names", () => {
    expect(RemoteSkill.parseNamespace("wrangler")).toBe(undefined)
    expect(RemoteSkill.parseNamespace("my-skill")).toBe(undefined)
  })

  test("returns undefined for empty skill name", () => {
    expect(RemoteSkill.parseNamespace("cloudflare.com/")).toBe(undefined)
  })

  test("returns undefined for names without slash", () => {
    expect(RemoteSkill.parseNamespace("cloudflare.com")).toBe(undefined)
  })
})

describe("RemoteSkill.isNamespaced", () => {
  test("returns true for valid namespaced identifiers", () => {
    expect(RemoteSkill.isNamespaced("cloudflare.com/wrangler")).toBe(true)
    expect(RemoteSkill.isNamespaced("example.com:8080/my-skill")).toBe(true)
  })

  test("returns false for local skill paths", () => {
    expect(RemoteSkill.isNamespaced("category/skill")).toBe(false)
    expect(RemoteSkill.isNamespaced("wrangler")).toBe(false)
  })
})

describe("RemoteSkill.getCached", () => {
  const domain1 = "test-ns-" + Date.now() + ".com"
  const domain2 = "other-ns-" + Date.now() + ".com"
  const skill = "wrangler"

  afterEach(async () => {
    // Clean up test cache directories
    await fs.rm(RemoteSkill.getCachePath(domain1, skill), { recursive: true, force: true })
    await fs.rm(RemoteSkill.getCachePath(domain2, skill), { recursive: true, force: true })
  })

  test("returns undefined for non-namespaced identifier", async () => {
    const result = await RemoteSkill.getCached("wrangler")
    expect(result).toBe(undefined)
  })

  test("returns undefined when skill is not cached", async () => {
    const result = await RemoteSkill.getCached(`${domain1}/${skill}`)
    expect(result).toBe(undefined)
  })

  test("returns cached skill content and metadata", async () => {
    const dir = RemoteSkill.getCachePath(domain1, skill)
    const content = "# Wrangler Skill\n\nThis is a test."

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), content)
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))

    const result = await RemoteSkill.getCached(`${domain1}/${skill}`)
    expect(result).not.toBe(undefined)
    expect(result!.content).toBe(content)
    expect(result!.dir).toBe(dir)
    expect(result!.domain).toBe(domain1)
    expect(result!.skill).toBe(skill)
  })

  test("same-named skills from different domains can coexist", async () => {
    // Both cloudflare.com/wrangler and example.com/wrangler can exist
    const dir1 = RemoteSkill.getCachePath(domain1, skill)
    const dir2 = RemoteSkill.getCachePath(domain2, skill)
    const content1 = "# Wrangler from domain1"
    const content2 = "# Wrangler from domain2"

    await fs.mkdir(dir1, { recursive: true })
    await Bun.write(path.join(dir1, "SKILL.md"), content1)
    await Bun.write(path.join(dir1, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))

    await fs.mkdir(dir2, { recursive: true })
    await Bun.write(path.join(dir2, "SKILL.md"), content2)
    await Bun.write(path.join(dir2, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))

    const result1 = await RemoteSkill.getCached(`${domain1}/${skill}`)
    const result2 = await RemoteSkill.getCached(`${domain2}/${skill}`)

    expect(result1!.content).toBe(content1)
    expect(result2!.content).toBe(content2)
    expect(result1!.domain).toBe(domain1)
    expect(result2!.domain).toBe(domain2)
  })
})

describe("RemoteSkill.listCached", () => {
  const domain = "test-list-" + Date.now() + ".com"

  afterEach(async () => {
    // Clean up test cache directories
    const baseDir = path.join(Global.Path.remoteSkills, domain)
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test("returns empty array when no skills cached", async () => {
    const result = await RemoteSkill.listCached()
    // Filter to only our test domain to avoid interference
    const filtered = result.filter((r) => r.domain === domain)
    expect(filtered).toEqual([])
  })

  test("lists all cached skills with namespaced ids", async () => {
    const skills = ["wrangler", "d1", "workers"]

    for (const skill of skills) {
      const dir = RemoteSkill.getCachePath(domain, skill)
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(path.join(dir, "SKILL.md"), `# ${skill}`)
      await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))
    }

    const result = await RemoteSkill.listCached()
    const filtered = result.filter((r) => r.domain === domain)

    expect(filtered).toHaveLength(3)
    expect(filtered.map((r) => r.id).sort()).toEqual([`${domain}/d1`, `${domain}/workers`, `${domain}/wrangler`])
  })

  test("excludes directories without SKILL.md", async () => {
    const dir1 = RemoteSkill.getCachePath(domain, "valid-skill")
    const dir2 = RemoteSkill.getCachePath(domain, "invalid-skill")

    await fs.mkdir(dir1, { recursive: true })
    await Bun.write(path.join(dir1, "SKILL.md"), "# Valid")
    await Bun.write(path.join(dir1, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))

    // Create a directory without SKILL.md
    await fs.mkdir(dir2, { recursive: true })
    await Bun.write(path.join(dir2, "_metadata.json"), JSON.stringify({ fetched: Date.now() }))

    const result = await RemoteSkill.listCached()
    const filtered = result.filter((r) => r.domain === domain)

    expect(filtered).toHaveLength(1)
    expect(filtered[0].skill).toBe("valid-skill")
  })
})

describe("RemoteSkill.fetchIndex", () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("fetches and parses valid index", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            skills: [
              { name: "wrangler", description: "Cloudflare Wrangler CLI helper", files: ["config.json"] },
              { name: "d1", description: "D1 database operations", files: ["scripts/migrate.sh"] },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.fetchIndex("example.com")

    expect(result.skills).toHaveLength(2)
    expect(result.skills[0]).toEqual({
      valid: true,
      skill: { name: "wrangler", description: "Cloudflare Wrangler CLI helper", files: ["config.json"] },
    })
    expect(result.skills[1]).toEqual({
      valid: true,
      skill: { name: "d1", description: "D1 database operations", files: ["scripts/migrate.sh"] },
    })
  })

  test("enforces HTTPS for all requests", async () => {
    let requestedUrl: string | undefined
    globalThis.fetch = mock((url: string | URL | Request) => {
      requestedUrl = url.toString()
      return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    }) as unknown as typeof fetch

    await RemoteSkill.fetchIndex("example.com")
    expect(requestedUrl).toBe("https://example.com/.well-known/skills/index.json")

    // Should also strip http:// if provided
    await RemoteSkill.fetchIndex("http://example.com")
    expect(requestedUrl).toBe("https://example.com/.well-known/skills/index.json")

    // Should strip https:// and re-add it
    await RemoteSkill.fetchIndex("https://example.com")
    expect(requestedUrl).toBe("https://example.com/.well-known/skills/index.json")
  })

  test("supports custom ports", async () => {
    let requestedUrl: string | undefined
    globalThis.fetch = mock((url: string | URL | Request) => {
      requestedUrl = url.toString()
      return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    }) as unknown as typeof fetch

    await RemoteSkill.fetchIndex("example.com:8080")
    expect(requestedUrl).toBe("https://example.com:8080/.well-known/skills/index.json")
  })

  test("handles 404 gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    ) as unknown as typeof fetch

    await expect(RemoteSkill.fetchIndex("example.com")).rejects.toThrow()

    try {
      await RemoteSkill.fetchIndex("example.com")
    } catch (err) {
      expect(RemoteSkill.FetchError.isInstance(err)).toBe(true)
      if (RemoteSkill.FetchError.isInstance(err)) {
        expect(err.data.status).toBe(404)
        expect(err.data.domain).toBe("example.com")
        expect(err.data.message).toContain("No skills index found")
      }
    }
  })

  test("handles malformed JSON gracefully", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("{ invalid json", { status: 200 })),
    ) as unknown as typeof fetch

    await expect(RemoteSkill.fetchIndex("example.com")).rejects.toThrow()

    try {
      await RemoteSkill.fetchIndex("example.com")
    } catch (err) {
      expect(RemoteSkill.ParseError.isInstance(err)).toBe(true)
      if (RemoteSkill.ParseError.isInstance(err)) {
        expect(err.data.domain).toBe("example.com")
        expect(err.data.message).toContain("Invalid JSON")
      }
    }
  })

  test("handles missing skills array", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ version: "1.0" }), { status: 200 })),
    ) as unknown as typeof fetch

    await expect(RemoteSkill.fetchIndex("example.com")).rejects.toThrow()

    try {
      await RemoteSkill.fetchIndex("example.com")
    } catch (err) {
      expect(RemoteSkill.ParseError.isInstance(err)).toBe(true)
      if (RemoteSkill.ParseError.isInstance(err)) {
        expect(err.data.message).toContain("skills")
      }
    }
  })

  test("marks entries with missing required fields as invalid", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            skills: [
              { name: "valid-skill", description: "This is valid", files: ["config.json"] },
              { name: "missing-description", files: ["a.txt"] },
              { description: "missing name", files: ["b.txt"] },
              { notaskill: true },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.fetchIndex("example.com")

    expect(result.skills).toHaveLength(4)

    // First entry should be valid
    expect(result.skills[0].valid).toBe(true)

    // Other entries should be invalid
    expect(result.skills[1].valid).toBe(false)
    expect(result.skills[2].valid).toBe(false)
    expect(result.skills[3].valid).toBe(false)

    // Invalid entries should have reason
    if (!result.skills[1].valid) {
      expect(result.skills[1].reason).toBeDefined()
      expect(result.skills[1].raw).toEqual({ name: "missing-description", files: ["a.txt"] })
    }
  })

  test("marks skills without files array as invalid", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            skills: [
              { name: "has-files", description: "Valid skill", files: ["config.json"] },
              { name: "no-files", description: "Missing files array" },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.fetchIndex("example.com")

    expect(result.skills).toHaveLength(2)

    // First entry should be valid
    expect(result.skills[0].valid).toBe(true)
    if (result.skills[0].valid) {
      expect(result.skills[0].skill.name).toBe("has-files")
    }

    // Second entry should be invalid due to missing files
    expect(result.skills[1].valid).toBe(false)
    if (!result.skills[1].valid) {
      expect(result.skills[1].reason).toBe("missing files array")
      expect(result.skills[1].raw).toEqual({ name: "no-files", description: "Missing files array" })
    }
  })

  test("marks skills with empty files array as invalid", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            skills: [
              { name: "has-files", description: "Valid skill", files: ["config.json"] },
              { name: "empty-files", description: "Empty files array", files: [] },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.fetchIndex("example.com")

    expect(result.skills).toHaveLength(2)

    // First entry should be valid
    expect(result.skills[0].valid).toBe(true)
    if (result.skills[0].valid) {
      expect(result.skills[0].skill.name).toBe("has-files")
    }

    // Second entry should be invalid due to empty files
    expect(result.skills[1].valid).toBe(false)
    if (!result.skills[1].valid) {
      expect(result.skills[1].reason).toBe("empty files array")
      expect(result.skills[1].raw).toEqual({ name: "empty-files", description: "Empty files array", files: [] })
    }
  })

  test("handles network errors", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network failure"))) as unknown as typeof fetch

    await expect(RemoteSkill.fetchIndex("example.com")).rejects.toThrow()

    try {
      await RemoteSkill.fetchIndex("example.com")
    } catch (err) {
      expect(RemoteSkill.FetchError.isInstance(err)).toBe(true)
      if (RemoteSkill.FetchError.isInstance(err)) {
        expect(err.data.domain).toBe("example.com")
        expect(err.data.message).toContain("Network failure")
      }
    }
  })

  test("handles non-200 status codes", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Server Error", { status: 500, statusText: "Internal Server Error" })),
    ) as unknown as typeof fetch

    try {
      await RemoteSkill.fetchIndex("example.com")
    } catch (err) {
      expect(RemoteSkill.FetchError.isInstance(err)).toBe(true)
      if (RemoteSkill.FetchError.isInstance(err)) {
        expect(err.data.status).toBe(500)
        expect(err.data.message).toContain("500")
      }
    }
  })

  test("strips trailing slashes from domain", async () => {
    let requestedUrl: string | undefined
    globalThis.fetch = mock((url: string | URL | Request) => {
      requestedUrl = url.toString()
      return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    }) as unknown as typeof fetch

    await RemoteSkill.fetchIndex("example.com/")
    expect(requestedUrl).toBe("https://example.com/.well-known/skills/index.json")
  })
})

describe("RemoteSkill.getCachePath", () => {
  test("returns correct path for domain and skill", () => {
    const result = RemoteSkill.getCachePath("example.com", "wrangler")
    expect(result).toBe(path.join(Global.Path.remoteSkills, "example.com", "wrangler"))
  })

  test("handles custom ports in domain", () => {
    const result = RemoteSkill.getCachePath("example.com:8080", "wrangler")
    expect(result).toBe(path.join(Global.Path.remoteSkills, "example.com:8080", "wrangler"))
  })
})

describe("RemoteSkill.isCached", () => {
  const domain = "test-cache-" + Date.now() + ".com"
  const skill = "test-skill"

  afterEach(async () => {
    // Clean up test cache directory
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("returns false when skill is not cached", async () => {
    const result = await RemoteSkill.isCached(domain, skill)
    expect(result).toBe(false)
  })

  test("returns true when skill is cached", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    const metadata: RemoteSkill.Metadata = { fetched: Date.now() }
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify(metadata))

    const result = await RemoteSkill.isCached(domain, skill)
    expect(result).toBe(true)
  })
})

describe("RemoteSkill.isStale", () => {
  const domain = "test-stale-" + Date.now() + ".com"
  const skill = "test-skill"

  afterEach(async () => {
    // Clean up test cache directory
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("returns true when skill is not cached", async () => {
    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(true)
  })

  test("returns true when metadata has no expires field", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    const metadata: RemoteSkill.Metadata = { fetched: Date.now() }
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify(metadata))

    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(true)
  })

  test("returns true when cache has expired", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    const metadata: RemoteSkill.Metadata = {
      fetched: Date.now() - 60000,
      expires: Date.now() - 30000, // Expired 30 seconds ago
    }
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify(metadata))

    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(true)
  })

  test("returns false when cache is still valid", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    const metadata: RemoteSkill.Metadata = {
      fetched: Date.now(),
      expires: Date.now() + 60000, // Expires in 60 seconds
    }
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify(metadata))

    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(false)
  })

  test("returns true when metadata is invalid JSON", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "_metadata.json"), "{ invalid json")

    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(true)
  })

  test("returns true when metadata schema is invalid", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify({ wrong: "schema" }))

    const result = await RemoteSkill.isStale(domain, skill)
    expect(result).toBe(true)
  })
})

describe("RemoteSkill.getMetadata", () => {
  const domain = "test-metadata-" + Date.now() + ".com"
  const skill = "test-skill"

  afterEach(async () => {
    // Clean up test cache directory
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("returns undefined when skill is not cached", async () => {
    const result = await RemoteSkill.getMetadata(domain, skill)
    expect(result).toBe(undefined)
  })

  test("returns metadata when skill is cached", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    const metadata: RemoteSkill.Metadata = {
      etag: '"abc123"',
      expires: Date.now() + 60000,
      fetched: Date.now(),
    }
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify(metadata))

    const result = await RemoteSkill.getMetadata(domain, skill)
    expect(result).toEqual(metadata)
  })

  test("returns undefined when metadata is invalid", async () => {
    const dir = RemoteSkill.getCachePath(domain, skill)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "_metadata.json"), "{ invalid")

    const result = await RemoteSkill.getMetadata(domain, skill)
    expect(result).toBe(undefined)
  })
})

describe("RemoteSkill.download", () => {
  let originalFetch: typeof fetch
  const domain = "test-download-" + Date.now() + ".com"

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    // Clean up all test cache directories
    const baseDir = path.join(Global.Path.remoteSkills, domain)
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test("downloads SKILL.md and writes to cache directory", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "wrangler", description: "Test skill" }
    const content = "# Wrangler Skill\n\nThis is a test skill."

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = url.toString()
      if (urlStr.includes("SKILL.md")) {
        return Promise.resolve(new Response(content, { status: 200 }))
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }))
    }) as unknown as typeof fetch

    const dir = await RemoteSkill.download(domain, skill)

    // Verify SKILL.md was written
    const skillFile = Bun.file(path.join(dir, "SKILL.md"))
    expect(await skillFile.exists()).toBe(true)
    expect(await skillFile.text()).toBe(content)

    // Verify metadata was written
    const metadataFile = Bun.file(path.join(dir, "_metadata.json"))
    expect(await metadataFile.exists()).toBe(true)
    const metadata = await metadataFile.json()
    expect(metadata.fetched).toBeDefined()
  })

  test("downloads all files from files array", async () => {
    const skill: RemoteSkill.SkillEntry = {
      name: "d1",
      description: "D1 skill",
      files: ["scripts/migrate.sh", "references/schema.sql"],
    }

    const fileContents: Record<string, string> = {
      "SKILL.md": "# D1 Skill",
      "scripts/migrate.sh": "#!/bin/bash\necho migrate",
      "references/schema.sql": "CREATE TABLE users (id INT);",
    }

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = url.toString()
      for (const [file, content] of Object.entries(fileContents)) {
        if (urlStr.endsWith(file)) {
          return Promise.resolve(new Response(content, { status: 200 }))
        }
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }))
    }) as unknown as typeof fetch

    const dir = await RemoteSkill.download(domain, skill)

    // Verify all files were written
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe("# D1 Skill")
    expect(await Bun.file(path.join(dir, "scripts/migrate.sh")).text()).toBe("#!/bin/bash\necho migrate")
    expect(await Bun.file(path.join(dir, "references/schema.sql")).text()).toBe("CREATE TABLE users (id INT);")
  })

  test("preserves directory structure for nested files", async () => {
    const skill: RemoteSkill.SkillEntry = {
      name: "nested",
      description: "Nested skill",
      files: ["assets/images/logo.png", "scripts/deep/nested/file.sh"],
    }

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = url.toString()
      if (urlStr.endsWith("SKILL.md")) {
        return Promise.resolve(new Response("# Nested", { status: 200 }))
      }
      if (urlStr.endsWith("logo.png")) {
        return Promise.resolve(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }))
      }
      if (urlStr.endsWith("file.sh")) {
        return Promise.resolve(new Response("#!/bin/bash", { status: 200 }))
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }))
    }) as unknown as typeof fetch

    const dir = await RemoteSkill.download(domain, skill)

    // Verify nested directories exist
    expect(await Bun.file(path.join(dir, "assets/images/logo.png")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "scripts/deep/nested/file.sh")).exists()).toBe(true)
  })

  test("writes metadata with cache headers", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "cached", description: "Cached skill" }
    const now = Date.now()

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("# Skill", {
          status: 200,
          headers: {
            ETag: '"abc123"',
            "Cache-Control": "max-age=3600",
          },
        }),
      ),
    ) as unknown as typeof fetch

    const dir = await RemoteSkill.download(domain, skill)

    const metadata = await Bun.file(path.join(dir, "_metadata.json")).json()
    expect(metadata.etag).toBe('"abc123"')
    expect(metadata.expires).toBeGreaterThan(now + 3599 * 1000) // At least 3599 seconds in future
    expect(metadata.expires).toBeLessThan(now + 3601 * 1000) // At most 3601 seconds in future
    expect(metadata.fetched).toBeGreaterThanOrEqual(now)
  })

  test("overwrites existing cache when refreshing", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "refresh", description: "Refresh skill" }
    const dir = RemoteSkill.getCachePath(domain, skill.name)

    // Create existing cache
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), "# Old Content")
    await Bun.write(path.join(dir, "_metadata.json"), JSON.stringify({ fetched: 1000 }))

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("# New Content", { status: 200 })),
    ) as unknown as typeof fetch

    await RemoteSkill.download(domain, skill)

    // Verify content was overwritten
    expect(await Bun.file(path.join(dir, "SKILL.md")).text()).toBe("# New Content")
    const metadata = await Bun.file(path.join(dir, "_metadata.json")).json()
    expect(metadata.fetched).toBeGreaterThan(1000)
  })

  test("throws DownloadError when SKILL.md fetch fails", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "failing", description: "Failing skill" }

    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as unknown as typeof fetch

    try {
      await RemoteSkill.download(domain, skill)
      expect(true).toBe(false) // Should not reach here
    } catch (err) {
      expect(RemoteSkill.DownloadError.isInstance(err)).toBe(true)
      if (RemoteSkill.DownloadError.isInstance(err)) {
        expect(err.data.domain).toBe(domain)
        expect(err.data.skill).toBe("failing")
        expect(err.data.file).toBe("SKILL.md")
        expect(err.data.message).toContain("Network error")
      }
    }
  })

  test("throws DownloadError when SKILL.md returns non-200", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "missing", description: "Missing skill" }

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    ) as unknown as typeof fetch

    try {
      await RemoteSkill.download(domain, skill)
      expect(true).toBe(false) // Should not reach here
    } catch (err) {
      expect(RemoteSkill.DownloadError.isInstance(err)).toBe(true)
      if (RemoteSkill.DownloadError.isInstance(err)) {
        expect(err.data.status).toBe(404)
        expect(err.data.file).toBe("SKILL.md")
      }
    }
  })

  test("throws DownloadError when additional file fetch fails", async () => {
    const skill: RemoteSkill.SkillEntry = {
      name: "partial",
      description: "Partial skill",
      files: ["missing.txt"],
    }

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = url.toString()
      if (urlStr.endsWith("SKILL.md")) {
        return Promise.resolve(new Response("# Skill", { status: 200 }))
      }
      return Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" }))
    }) as unknown as typeof fetch

    try {
      await RemoteSkill.download(domain, skill)
      expect(true).toBe(false) // Should not reach here
    } catch (err) {
      expect(RemoteSkill.DownloadError.isInstance(err)).toBe(true)
      if (RemoteSkill.DownloadError.isInstance(err)) {
        expect(err.data.file).toBe("missing.txt")
        expect(err.data.status).toBe(404)
      }
    }
  })

  test("uses correct URL structure for skill files", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "wrangler", description: "Test" }
    const urls: string[] = []

    globalThis.fetch = mock((url: string | URL | Request) => {
      urls.push(url.toString())
      return Promise.resolve(new Response("# Content", { status: 200 }))
    }) as unknown as typeof fetch

    await RemoteSkill.download(domain, skill)

    expect(urls[0]).toBe(`https://${domain}/.well-known/skills/wrangler/SKILL.md`)
  })
})

describe("RemoteSkill e2e", () => {
  let server: ReturnType<typeof Bun.serve>
  let domain: string
  let originalFetch: typeof fetch

  // Mock skill data
  const skills = {
    wrangler: {
      name: "wrangler",
      description: "Cloudflare Wrangler CLI helper",
      files: ["scripts/deploy.sh"],
    },
    d1: {
      name: "d1",
      description: "D1 database operations",
      files: ["references/schema.sql", "assets/logo.png"],
    },
  }

  // Content for mock skill files (mutable for refresh tests)
  let content: Record<string, string | Uint8Array> = {}

  // Track request counts for caching tests
  let requestLog: string[] = []

  beforeEach(() => {
    originalFetch = globalThis.fetch
    requestLog = []

    // Reset content for each test
    content = {
      "wrangler/SKILL.md": "# Wrangler Skill\n\nHelp with Cloudflare Wrangler CLI.",
      "wrangler/scripts/deploy.sh": "#!/bin/bash\nwrangler deploy",
      "d1/SKILL.md": "# D1 Skill\n\nHelp with D1 database.",
      "d1/references/schema.sql": "CREATE TABLE users (id INTEGER PRIMARY KEY);",
      "d1/assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const pathname = url.pathname
        requestLog.push(pathname)

        // Handle index.json
        if (pathname === "/.well-known/skills/index.json") {
          return new Response(
            JSON.stringify({
              skills: Object.values(skills),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "max-age=60",
              },
            },
          )
        }

        // Handle skill files
        const match = pathname.match(/^\/\.well-known\/skills\/([^/]+)\/(.+)$/)
        if (match) {
          const [, skill, file] = match
          const key = `${skill}/${file}`
          const data = content[key]

          if (data !== undefined) {
            const isText = typeof data === "string"
            const body = isText ? data : (data as BlobPart)
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": isText ? "text/plain" : "application/octet-stream",
                "Cache-Control": "max-age=3600",
                ETag: `"${skill}-${file}-v1"`,
              },
            })
          }
        }

        return new Response("Not Found", { status: 404 })
      },
    })

    // Domain uses a fake domain that we'll intercept
    domain = `e2e-test-${Date.now()}.example.com`

    // Intercept fetch calls to route HTTPS requests to our HTTP server
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      // Route requests for our test domain to the local server
      if (urlStr.includes(domain)) {
        const httpUrl = urlStr.replace(`https://${domain}`, `http://localhost:${server.port}`)
        return originalFetch(httpUrl, init)
      }
      return originalFetch(url, init)
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    server.stop()
    // Clean up cache
    const baseDir = path.join(Global.Path.remoteSkills, domain)
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test("full flow: list -> load -> read skill content", async () => {
    // Step 1: List skills from the domain
    const index = await RemoteSkill.fetchIndex(domain)

    expect(index.skills).toHaveLength(2)
    expect(index.skills.every((s) => s.valid)).toBe(true)
    expect(index.skills.map((s) => (s.valid ? s.skill.name : null))).toContain("wrangler")
    expect(index.skills.map((s) => (s.valid ? s.skill.name : null))).toContain("d1")

    // Step 2: Load a skill
    const skillEntry = index.skills.find((s) => s.valid && s.skill.name === "wrangler")
    if (!skillEntry || !skillEntry.valid) throw new Error("Skill not found")

    const result = await RemoteSkill.load(domain, skillEntry.skill)

    expect(result.content).toBe("# Wrangler Skill\n\nHelp with Cloudflare Wrangler CLI.")
    expect(result.dir).toBe(RemoteSkill.getCachePath(domain, "wrangler"))

    // Step 3: Verify all files were cached
    const skillDir = result.dir
    expect(await Bun.file(path.join(skillDir, "SKILL.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(skillDir, "scripts/deploy.sh")).exists()).toBe(true)
    expect(await Bun.file(path.join(skillDir, "scripts/deploy.sh")).text()).toBe("#!/bin/bash\nwrangler deploy")
    expect(await Bun.file(path.join(skillDir, "_metadata.json")).exists()).toBe(true)
  })

  test("caching: second load uses cache, no network requests", async () => {
    // First load - should hit the server
    const index = await RemoteSkill.fetchIndex(domain)
    const skillEntry = index.skills.find((s) => s.valid && s.skill.name === "d1")
    if (!skillEntry || !skillEntry.valid) throw new Error("Skill not found")

    const firstLoadRequestsBefore = requestLog.length
    const firstResult = await RemoteSkill.load(domain, skillEntry.skill)
    const firstLoadRequests = requestLog.length - firstLoadRequestsBefore

    // Should have made requests for SKILL.md + 2 additional files
    expect(firstLoadRequests).toBe(3)
    expect(firstResult.content).toBe("# D1 Skill\n\nHelp with D1 database.")

    // Second load - should use cache (within max-age=3600)
    const secondLoadRequestsBefore = requestLog.length
    const secondResult = await RemoteSkill.load(domain, skillEntry.skill)
    const secondLoadRequests = requestLog.length - secondLoadRequestsBefore

    // Should make NO requests (served from cache)
    expect(secondLoadRequests).toBe(0)
    expect(secondResult.content).toBe(firstResult.content)
    expect(secondResult.dir).toBe(firstResult.dir)
  })

  test("cache refresh: stale cache triggers refresh when server available", async () => {
    // First load to populate cache
    const index = await RemoteSkill.fetchIndex(domain)
    const skillEntry = index.skills.find((s) => s.valid && s.skill.name === "wrangler")
    if (!skillEntry || !skillEntry.valid) throw new Error("Skill not found")

    await RemoteSkill.load(domain, skillEntry.skill)

    // Manually make the cache stale by setting expired timestamp
    const metadataPath = path.join(RemoteSkill.getCachePath(domain, "wrangler"), "_metadata.json")
    const metadata = await Bun.file(metadataPath).json()
    await Bun.write(
      metadataPath,
      JSON.stringify({
        ...metadata,
        expires: Date.now() - 1000, // Expired 1 second ago
      }),
    )

    // Verify cache is now stale
    expect(await RemoteSkill.isStale(domain, "wrangler")).toBe(true)

    // Update the mock content to detect refresh
    content["wrangler/SKILL.md"] = "# Wrangler Skill v2\n\nUpdated content."

    // Load again - should refresh from server
    const refreshRequestsBefore = requestLog.length
    const refreshResult = await RemoteSkill.load(domain, skillEntry.skill)
    const refreshRequests = requestLog.length - refreshRequestsBefore

    // Should have made requests to refresh
    expect(refreshRequests).toBeGreaterThan(0)
    expect(refreshResult.content).toBe("# Wrangler Skill v2\n\nUpdated content.")
  })

  test("binary files are cached correctly", async () => {
    const index = await RemoteSkill.fetchIndex(domain)
    const skillEntry = index.skills.find((s) => s.valid && s.skill.name === "d1")
    if (!skillEntry || !skillEntry.valid) throw new Error("Skill not found")

    await RemoteSkill.load(domain, skillEntry.skill)

    // Check binary file was cached correctly
    const logoPath = path.join(RemoteSkill.getCachePath(domain, "d1"), "assets/logo.png")
    expect(await Bun.file(logoPath).exists()).toBe(true)

    const cached = new Uint8Array(await Bun.file(logoPath).arrayBuffer())
    const expected = content["d1/assets/logo.png"] as Uint8Array
    expect(cached.length).toBe(expected.length)
    expect(Array.from(cached)).toEqual(Array.from(expected))
  })

  test("namespaced lookup works after caching", async () => {
    // Load skill through normal flow
    const index = await RemoteSkill.fetchIndex(domain)
    const skillEntry = index.skills.find((s) => s.valid && s.skill.name === "wrangler")
    if (!skillEntry || !skillEntry.valid) throw new Error("Skill not found")

    await RemoteSkill.load(domain, skillEntry.skill)

    // Now lookup by namespaced identifier
    const namespaced = RemoteSkill.namespace(domain, "wrangler")
    expect(namespaced).toBe(`${domain}/wrangler`)

    const cached = await RemoteSkill.getCached(namespaced)
    expect(cached).not.toBe(undefined)
    expect(cached!.content).toContain("Wrangler")
    expect(cached!.domain).toBe(domain)
    expect(cached!.skill).toBe("wrangler")
  })
})

describe("RemoteSkill.load", () => {
  let originalFetch: typeof fetch
  const domain = "test-load-" + Date.now() + ".com"

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    // Clean up all test cache directories
    const baseDir = path.join(Global.Path.remoteSkills, domain)
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test("returns from cache when cached and not stale", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "cached-fresh", description: "Fresh cached skill" }
    const dir = RemoteSkill.getCachePath(domain, skill.name)
    const content = "# Cached Skill\n\nThis is cached."

    // Pre-populate cache with fresh data
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), content)
    await Bun.write(
      path.join(dir, "_metadata.json"),
      JSON.stringify({
        fetched: Date.now(),
        expires: Date.now() + 60000, // Expires in 60 seconds
      }),
    )

    // Mock fetch should NOT be called
    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve(new Response("# New Content", { status: 200 }))
    }) as unknown as typeof fetch

    const result = await RemoteSkill.load(domain, skill)

    expect(fetchCalled).toBe(false)
    expect(result.content).toBe(content)
    expect(result.dir).toBe(dir)
  })

  test("refreshes cache when stale and network available", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "cached-stale", description: "Stale cached skill" }
    const dir = RemoteSkill.getCachePath(domain, skill.name)
    const oldContent = "# Old Content"
    const newContent = "# New Content"

    // Pre-populate cache with stale data
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), oldContent)
    await Bun.write(
      path.join(dir, "_metadata.json"),
      JSON.stringify({
        fetched: Date.now() - 120000,
        expires: Date.now() - 60000, // Expired 60 seconds ago
      }),
    )

    // Mock fetch returns new content
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(newContent, {
          status: 200,
          headers: { "Cache-Control": "max-age=3600" },
        }),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.load(domain, skill)

    expect(result.content).toBe(newContent)
    expect(result.dir).toBe(dir)

    // Verify cache was updated
    const cachedContent = await Bun.file(path.join(dir, "SKILL.md")).text()
    expect(cachedContent).toBe(newContent)
  })

  test("serves stale content when network unavailable", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "cached-offline", description: "Offline skill" }
    const dir = RemoteSkill.getCachePath(domain, skill.name)
    const staleContent = "# Stale Content"

    // Pre-populate cache with stale data
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "SKILL.md"), staleContent)
    await Bun.write(
      path.join(dir, "_metadata.json"),
      JSON.stringify({
        fetched: Date.now() - 120000,
        expires: Date.now() - 60000, // Expired 60 seconds ago
      }),
    )

    // Mock fetch fails
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unavailable"))) as unknown as typeof fetch

    const result = await RemoteSkill.load(domain, skill)

    // Should return stale content silently
    expect(result.content).toBe(staleContent)
    expect(result.dir).toBe(dir)
  })

  test("downloads and caches when not cached", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "not-cached", description: "New skill" }
    const dir = RemoteSkill.getCachePath(domain, skill.name)
    const content = "# Fresh Download"

    // Mock fetch returns content
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(content, {
          status: 200,
          headers: { "Cache-Control": "max-age=3600" },
        }),
      ),
    ) as unknown as typeof fetch

    const result = await RemoteSkill.load(domain, skill)

    expect(result.content).toBe(content)
    expect(result.dir).toBe(dir)

    // Verify cache was created
    expect(await Bun.file(path.join(dir, "SKILL.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "_metadata.json")).exists()).toBe(true)
  })

  test("throws LoadError when not cached and network unavailable", async () => {
    const skill: RemoteSkill.SkillEntry = { name: "unavailable", description: "Unavailable skill" }

    // Mock fetch fails
    globalThis.fetch = mock(() => Promise.reject(new Error("Network unavailable"))) as unknown as typeof fetch

    try {
      await RemoteSkill.load(domain, skill)
      expect(true).toBe(false) // Should not reach here
    } catch (err) {
      expect(RemoteSkill.LoadError.isInstance(err)).toBe(true)
      if (RemoteSkill.LoadError.isInstance(err)) {
        expect(err.data.domain).toBe(domain)
        expect(err.data.skill).toBe("unavailable")
        expect(err.data.message).toContain("Failed to load skill")
      }
    }
  })
})
