import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test"
import { RemoteSkillTool } from "../../src/tool/remote-skill"
import { SkillTool } from "../../src/tool/skill"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

describe("RemoteSkillTool", () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const createContext = (overrides?: { ask?: (params: any) => Promise<void> }) =>
    ({
      sessionID: "test-session",
      messageID: "test-message",
      agent: "test-agent",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    }) as any

  describe("list action", () => {
    test("returns formatted output with skill names and descriptions", async () => {
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

      const tool = await RemoteSkillTool.init()
      const result = await tool.execute({ action: "list", domain: "cloudflare.com" }, createContext())

      expect(result.title).toBe("Listed skills from cloudflare.com")
      expect(result.output).toContain("## Remote Skills from cloudflare.com")
      expect(result.output).toContain("**wrangler**: Cloudflare Wrangler CLI helper")
      expect(result.output).toContain("**d1**: D1 database operations (1 additional files)")
      expect(result.metadata.domain).toBe("cloudflare.com")
      expect(result.metadata.total).toBe(2)
      expect(result.metadata.valid).toBe(2)
    })

    test("shows invalid markers for malformed skill entries", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              skills: [
                { name: "valid-skill", description: "This is valid", files: ["config.json"] },
                { name: "missing-description", files: ["a.txt"] },
                { notaskill: true },
              ],
            }),
            { status: 200 },
          ),
        ),
      ) as unknown as typeof fetch

      const tool = await RemoteSkillTool.init()
      const result = await tool.execute({ action: "list", domain: "example.com" }, createContext())

      expect(result.output).toContain("**valid-skill**: This is valid")
      expect(result.output).toContain("*(invalid:")
      expect(result.output).toContain("missing-description")
      expect(result.metadata.total).toBe(3)
      expect(result.metadata.valid).toBe(1)
    })

    test("handles empty skills list", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 })),
      ) as unknown as typeof fetch

      const tool = await RemoteSkillTool.init()
      const result = await tool.execute({ action: "list", domain: "empty.com" }, createContext())

      expect(result.output).toContain("No skills found at this domain.")
      expect(result.metadata.total).toBe(0)
    })

    test("does not require permission prompt", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 })),
      ) as unknown as typeof fetch

      let askCalled = false
      const ctx = {
        ...createContext(),
        ask: async () => {
          askCalled = true
        },
      }

      const tool = await RemoteSkillTool.init()
      await tool.execute({ action: "list", domain: "example.com" }, ctx)

      expect(askCalled).toBe(false)
    })

    test("supports custom ports in domain", async () => {
      let requestedUrl: string | undefined
      globalThis.fetch = mock((url: string | URL | Request) => {
        requestedUrl = url.toString()
        return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
      }) as unknown as typeof fetch

      const tool = await RemoteSkillTool.init()
      await tool.execute({ action: "list", domain: "localhost:8080" }, createContext())

      expect(requestedUrl).toBe("https://localhost:8080/.well-known/skills/index.json")
    })

    test("propagates fetch errors", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
      ) as unknown as typeof fetch

      const tool = await RemoteSkillTool.init()

      await expect(tool.execute({ action: "list", domain: "notfound.com" }, createContext())).rejects.toThrow()
    })
  })

  describe("load action", () => {
    test("requires skill parameter", async () => {
      const tool = await RemoteSkillTool.init()

      await expect(tool.execute({ action: "load", domain: "example.com" }, createContext())).rejects.toThrow(
        "'skill' parameter is required",
      )
    })

    test("triggers permission prompt for untrusted domains", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              // No trustedDomains - domain is untrusted
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Mock fetch to return a valid index and skill
          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [{ name: "test-skill", description: "A test skill", files: ["config.json"] }],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(new Response("# Test Skill\nThis is a test skill.", { status: 200 }))
            }
            if (urlStr.includes("config.json")) {
              return Promise.resolve(new Response("{}", { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          let askCalled = false
          let askParams: any = null
          const ctx = createContext({
            ask: async (params: any) => {
              askCalled = true
              askParams = params
            },
          })

          const tool = await RemoteSkillTool.init()
          await tool.execute({ action: "load", domain: "example.com", skill: "test-skill" }, ctx)

          expect(askCalled).toBe(true)
          expect(askParams.permission).toBe("remote-skill")
          expect(askParams.patterns).toContain("example.com")
          expect(askParams.always).toContain("example.com")
        },
      })
    })

    test("trusted domain skips permission prompt", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["trusted.example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Mock fetch to return a valid index and skill
          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [{ name: "test-skill", description: "A test skill", files: ["config.json"] }],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(new Response("# Test Skill\nThis is a test skill.", { status: 200 }))
            }
            if (urlStr.includes("config.json")) {
              return Promise.resolve(new Response("{}", { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          let askCalled = false
          const ctx = createContext({
            ask: async () => {
              askCalled = true
            },
          })

          const tool = await RemoteSkillTool.init()
          await tool.execute({ action: "load", domain: "trusted.example.com", skill: "test-skill" }, ctx)

          expect(askCalled).toBe(false)
        },
      })
    })

    test("downloads all skill files to cache", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Mock fetch to return index with additional files
          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [
                      {
                        name: "multi-file-skill",
                        description: "Skill with multiple files",
                        files: ["scripts/helper.sh", "data/config.json"],
                      },
                    ],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(
                new Response("# Multi File Skill\nSkill content here.", {
                  status: 200,
                  headers: { "cache-control": "max-age=3600" },
                }),
              )
            }
            if (urlStr.includes("scripts/helper.sh")) {
              return Promise.resolve(new Response("#!/bin/bash\necho hello", { status: 200 }))
            }
            if (urlStr.includes("data/config.json")) {
              return Promise.resolve(new Response('{"key": "value"}', { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          const tool = await RemoteSkillTool.init()
          const result = await tool.execute(
            { action: "load", domain: "example.com", skill: "multi-file-skill" },
            createContext(),
          )

          // Check cache directory was created
          const cacheDir = path.join(Global.Path.remoteSkills, "example.com", "multi-file-skill")
          expect(await Bun.file(path.join(cacheDir, "SKILL.md")).exists()).toBe(true)
          expect(await Bun.file(path.join(cacheDir, "scripts/helper.sh")).exists()).toBe(true)
          expect(await Bun.file(path.join(cacheDir, "data/config.json")).exists()).toBe(true)
          expect(await Bun.file(path.join(cacheDir, "_metadata.json")).exists()).toBe(true)

          // Clean up
          await fs.rm(cacheDir, { recursive: true, force: true })
        },
      })
    })

    test("returns skill content with correct base directory", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const skillContent = "# My Skill\n\nThis is the skill content."

          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [{ name: "my-skill", description: "My skill description", files: ["config.json"] }],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(new Response(skillContent, { status: 200 }))
            }
            if (urlStr.includes("config.json")) {
              return Promise.resolve(new Response("{}", { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          const tool = await RemoteSkillTool.init()
          const result = await tool.execute(
            { action: "load", domain: "example.com", skill: "my-skill" },
            createContext(),
          )

          // Check result structure
          expect(result.title).toBe("Loaded skill example.com/my-skill")
          expect(result.output).toContain(skillContent)
          expect(result.output).toContain("example.com/my-skill")
          expect(result.output).toContain("My skill description")
          expect(result.metadata.domain).toBe("example.com")
          expect(result.metadata.skill).toBe("my-skill")

          const cacheDir = path.join(Global.Path.remoteSkills, "example.com", "my-skill")
          expect(result.metadata.dir).toBe(cacheDir)

          // Clean up
          await fs.rm(cacheDir, { recursive: true, force: true })
        },
      })
    })

    test("allow always persists domain to global config", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Start with empty config - no trusted domains
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Bus } = await import("../../src/bus")
          const { PermissionNext } = await import("../../src/permission/next")

          // Mock fetch to return a valid index and skill
          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [{ name: "test-skill", description: "A test skill", files: ["config.json"] }],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(new Response("# Test Skill\nThis is a test skill.", { status: 200 }))
            }
            if (urlStr.includes("config.json")) {
              return Promise.resolve(new Response("{}", { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          // Create a context that simulates permission ask and immediately publishes "always" reply
          const ctx = createContext({
            ask: async (params: any) => {
              // Simulate the permission system replying with "always"
              // The tool subscribes to Replied events before calling ctx.ask()
              // So we need to publish the event asynchronously
              setTimeout(() => {
                Bus.publish(PermissionNext.Event.Replied, {
                  sessionID: "test-session",
                  requestID: "test-permission",
                  reply: "always",
                })
              }, 10)
              // Wait a bit for the event to be processed
              await new Promise((resolve) => setTimeout(resolve, 50))
            },
          })

          const tool = await RemoteSkillTool.init()
          await tool.execute({ action: "load", domain: "newdomain.com", skill: "test-skill" }, ctx)

          // Verify the domain was persisted to global config
          const configPath = path.join(Global.Path.config, "opencode.json")
          const configText = await Bun.file(configPath).text()
          const config = JSON.parse(configText)

          expect(config.trustedDomains).toBeDefined()
          expect(config.trustedDomains).toContain("newdomain.com")

          // Clean up
          const cacheDir = path.join(Global.Path.remoteSkills, "newdomain.com", "test-skill")
          await fs.rm(cacheDir, { recursive: true, force: true })
        },
      })
    })

    test("subsequent loads from trusted domain skip permission", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["already-trusted.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Mock fetch to return a valid index and skill
          globalThis.fetch = mock((url: string | URL | Request) => {
            const urlStr = url.toString()
            if (urlStr.includes("index.json")) {
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    skills: [{ name: "test-skill", description: "A test skill", files: ["config.json"] }],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (urlStr.includes("SKILL.md")) {
              return Promise.resolve(new Response("# Test Skill\nThis is a test skill.", { status: 200 }))
            }
            if (urlStr.includes("config.json")) {
              return Promise.resolve(new Response("{}", { status: 200 }))
            }
            return Promise.resolve(new Response("Not Found", { status: 404 }))
          }) as unknown as typeof fetch

          let firstAskCalled = false
          let secondAskCalled = false

          // First load - should not ask (already trusted)
          const tool = await RemoteSkillTool.init()
          await tool.execute(
            { action: "load", domain: "already-trusted.com", skill: "test-skill" },
            createContext({
              ask: async () => {
                firstAskCalled = true
              },
            }),
          )
          expect(firstAskCalled).toBe(false)

          // Second load of same domain - should also not ask
          await tool.execute(
            { action: "load", domain: "already-trusted.com", skill: "test-skill" },
            createContext({
              ask: async () => {
                secondAskCalled = true
              },
            }),
          )
          expect(secondAskCalled).toBe(false)

          // Clean up
          const cacheDir = path.join(Global.Path.remoteSkills, "already-trusted.com", "test-skill")
          await fs.rm(cacheDir, { recursive: true, force: true })
        },
      })
    })

    test("throws error when skill not found in index", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          globalThis.fetch = mock(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "other-skill", description: "Some other skill", files: ["a.txt"] }],
                }),
                { status: 200 },
              ),
            ),
          ) as unknown as typeof fetch

          const tool = await RemoteSkillTool.init()

          await expect(
            tool.execute({ action: "load", domain: "example.com", skill: "nonexistent" }, createContext()),
          ).rejects.toThrow("Skill 'nonexistent' not found")
        },
      })
    })

    test("fails with clear error when skill has no files array", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          globalThis.fetch = mock(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "no-files-skill", description: "Skill without files array" }],
                }),
                { status: 200 },
              ),
            ),
          ) as unknown as typeof fetch

          const tool = await RemoteSkillTool.init()

          await expect(
            tool.execute({ action: "load", domain: "example.com", skill: "no-files-skill" }, createContext()),
          ).rejects.toThrow("is invalid: missing files array")
        },
      })
    })

    test("fails with clear error when skill has empty files array", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              trustedDomains: ["example.com"],
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          globalThis.fetch = mock(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "empty-files-skill", description: "Skill with empty files", files: [] }],
                }),
                { status: 200 },
              ),
            ),
          ) as unknown as typeof fetch

          const tool = await RemoteSkillTool.init()

          await expect(
            tool.execute({ action: "load", domain: "example.com", skill: "empty-files-skill" }, createContext()),
          ).rejects.toThrow("is invalid: empty files array")
        },
      })
    })
  })

  describe("tool registration", () => {
    test("has correct id", () => {
      expect(RemoteSkillTool.id).toBe("remote-skill")
    })

    test("has description mentioning remote skills", async () => {
      const tool = await RemoteSkillTool.init()
      expect(tool.description).toContain("remote")
      expect(tool.description).toContain("skills")
    })

    test("appears in ToolRegistry.ids() output", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { ToolRegistry } = await import("../../src/tool/registry")
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("remote-skill")
        },
      })
    })
  })
})

describe("SkillTool - Local Precedence", () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const createContext = (overrides?: { ask?: (params: any) => Promise<void> }) =>
    ({
      sessionID: "test-session",
      messageID: "test-message",
      agent: "test-agent",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      ...overrides,
    }) as any

  test("local skill is returned for non-namespaced name (no remote fallback)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Create a local skill named "wrangler"
        const skillDir = path.join(dir, ".opencode", "skill", "wrangler")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: wrangler
description: Local wrangler skill for this project
---

# Local Wrangler

This is the LOCAL wrangler skill.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Even if a remote "cloudflare.com/wrangler" exists, requesting just "wrangler"
        // should return the local skill - NOT fall back to remote
        const tool = await SkillTool.init()
        const result = await tool.execute({ name: "wrangler" }, createContext())

        // Should return the LOCAL skill
        expect(result.output).toContain("Local Wrangler")
        expect(result.output).toContain("LOCAL wrangler skill")
        expect(result.metadata.dir).toContain(tmp.path)
      },
    })
  })

  test("non-namespaced name never triggers remote skill fetch", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // No local skills exist, and requesting a non-namespaced name
        // should NOT try to fetch from remote - should just error
        let fetchCalled = false
        globalThis.fetch = mock(() => {
          fetchCalled = true
          return Promise.resolve(
            new Response(
              JSON.stringify({
                skills: [{ name: "wrangler", description: "Remote wrangler" }],
              }),
              { status: 200 },
            ),
          )
        }) as unknown as typeof fetch

        const tool = await SkillTool.init()

        // Should throw "not found" error without ever calling fetch
        await expect(tool.execute({ name: "wrangler" }, createContext())).rejects.toThrow('Skill "wrangler" not found')

        // Remote should NOT have been contacted
        expect(fetchCalled).toBe(false)
      },
    })
  })

  test("remote skill requires explicit domain (namespaced format)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            trustedDomains: ["cloudflare.com"],
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Mock fetch to return a valid index and skill
        globalThis.fetch = mock((url: string | URL | Request) => {
          const urlStr = url.toString()
          if (urlStr.includes("index.json")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "wrangler", description: "Cloudflare Wrangler CLI", files: ["config.json"] }],
                }),
                { status: 200 },
              ),
            )
          }
          if (urlStr.includes("SKILL.md")) {
            return Promise.resolve(
              new Response(
                `---
name: wrangler
description: Cloudflare Wrangler CLI
---

# Remote Wrangler

This is the REMOTE wrangler from cloudflare.com.
`,
                { status: 200 },
              ),
            )
          }
          if (urlStr.includes("config.json")) {
            return Promise.resolve(new Response("{}", { status: 200 }))
          }
          return Promise.resolve(new Response("Not Found", { status: 404 }))
        }) as unknown as typeof fetch

        const tool = await SkillTool.init()

        // Request with explicit domain - should load remote
        const result = await tool.execute({ name: "cloudflare.com/wrangler" }, createContext())

        expect(result.output).toContain("Remote Wrangler")
        expect(result.output).toContain("REMOTE wrangler from cloudflare.com")
        expect(result.title).toContain("cloudflare.com/wrangler")

        // Clean up
        const cacheDir = path.join(Global.Path.remoteSkills, "cloudflare.com", "wrangler")
        await fs.rm(cacheDir, { recursive: true, force: true })
      },
    })
  })

  test("same-named local and remote skills can coexist", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Create a local skill named "wrangler"
        const skillDir = path.join(dir, ".opencode", "skill", "wrangler")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: wrangler
description: Local wrangler skill
---

# Local Wrangler

This is LOCAL.
`,
        )
        // Trust the remote domain
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            trustedDomains: ["cloudflare.com"],
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Mock remote skill
        globalThis.fetch = mock((url: string | URL | Request) => {
          const urlStr = url.toString()
          if (urlStr.includes("index.json")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "wrangler", description: "Cloudflare Wrangler CLI", files: ["config.json"] }],
                }),
                { status: 200 },
              ),
            )
          }
          if (urlStr.includes("SKILL.md")) {
            return Promise.resolve(
              new Response(
                `---
name: wrangler
description: Cloudflare Wrangler CLI
---

# Remote Wrangler

This is REMOTE.
`,
                { status: 200 },
              ),
            )
          }
          if (urlStr.includes("config.json")) {
            return Promise.resolve(new Response("{}", { status: 200 }))
          }
          return Promise.resolve(new Response("Not Found", { status: 404 }))
        }) as unknown as typeof fetch

        const tool = await SkillTool.init()

        // Request "wrangler" - should get LOCAL
        const local = await tool.execute({ name: "wrangler" }, createContext())
        expect(local.output).toContain("This is LOCAL.")

        // Request "cloudflare.com/wrangler" - should get REMOTE
        const remote = await tool.execute({ name: "cloudflare.com/wrangler" }, createContext())
        expect(remote.output).toContain("This is REMOTE.")

        // Clean up
        const cacheDir = path.join(Global.Path.remoteSkills, "cloudflare.com", "wrangler")
        await fs.rm(cacheDir, { recursive: true, force: true })
      },
    })
  })

  test("skill tool triggers permission prompt for untrusted remote domain", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // No trusted domains
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Mock remote skill
        globalThis.fetch = mock((url: string | URL | Request) => {
          const urlStr = url.toString()
          if (urlStr.includes("index.json")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  skills: [{ name: "test", description: "Test skill", files: ["config.json"] }],
                }),
                { status: 200 },
              ),
            )
          }
          if (urlStr.includes("SKILL.md")) {
            return Promise.resolve(new Response("# Test", { status: 200 }))
          }
          if (urlStr.includes("config.json")) {
            return Promise.resolve(new Response("{}", { status: 200 }))
          }
          return Promise.resolve(new Response("Not Found", { status: 404 }))
        }) as unknown as typeof fetch

        let askCalled = false
        let askPermission: string | undefined
        const ctx = createContext({
          ask: async (params: any) => {
            askCalled = true
            askPermission = params.permission
          },
        })

        const tool = await SkillTool.init()
        await tool.execute({ name: "untrusted.example.com/test" }, ctx)

        expect(askCalled).toBe(true)
        expect(askPermission).toBe("remote-skill")

        // Clean up
        const cacheDir = path.join(Global.Path.remoteSkills, "untrusted.example.com", "test")
        await fs.rm(cacheDir, { recursive: true, force: true })
      },
    })
  })

  test("skill tool fails with clear error for remote skill with no files array", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            trustedDomains: ["example.com"],
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                skills: [{ name: "no-files", description: "Missing files array" }],
              }),
              { status: 200 },
            ),
          ),
        ) as unknown as typeof fetch

        const tool = await SkillTool.init()

        await expect(tool.execute({ name: "example.com/no-files" }, createContext())).rejects.toThrow(
          "is invalid: missing files array",
        )
      },
    })
  })

  test("skill tool fails with clear error for remote skill with empty files array", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            trustedDomains: ["example.com"],
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                skills: [{ name: "empty-files", description: "Empty files array", files: [] }],
              }),
              { status: 200 },
            ),
          ),
        ) as unknown as typeof fetch

        const tool = await SkillTool.init()

        await expect(tool.execute({ name: "example.com/empty-files" }, createContext())).rejects.toThrow(
          "is invalid: empty files array",
        )
      },
    })
  })

  test("local category/skill paths are not treated as remote", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Create a local skill in a category directory
        const skillDir = path.join(dir, ".opencode", "skill", "testing")
        await Bun.write(
          path.join(skillDir, "SKILL.md"),
          `---
name: testing
description: Testing utilities skill
---

# Testing

This is a local testing skill.
`,
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Should NOT call fetch for local paths
        let fetchCalled = false
        globalThis.fetch = mock(() => {
          fetchCalled = true
          return Promise.resolve(new Response("", { status: 404 }))
        }) as unknown as typeof fetch

        const tool = await SkillTool.init()
        const result = await tool.execute({ name: "testing" }, createContext())

        expect(fetchCalled).toBe(false)
        expect(result.output).toContain("Testing")
        expect(result.output).toContain("local testing skill")
      },
    })
  })
})
