import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { RemoteSkill } from "../skill/remote"
import { Log } from "../util/log"
import { Config } from "../config/config"
import { Global } from "../global"
import { Bus } from "../bus"
import { PermissionNext } from "../permission/next"
import { modify, applyEdits } from "jsonc-parser"

const log = Log.create({ service: "tool.remote-skill" })

const parameters = z.object({
  action: z
    .enum(["list", "load"])
    .describe("The action to perform: 'list' to discover available skills, 'load' to fetch and use a skill"),
  domain: z.string().describe("The domain to fetch skills from (e.g., 'cloudflare.com', 'example.com:8080')"),
  skill: z.string().optional().describe("The skill name to load (required for 'load' action)"),
})

/**
 * Check if a domain is in the trusted domains list
 */
async function isTrustedDomain(domain: string): Promise<boolean> {
  const config = await Config.get()
  const trusted = config.trustedDomains ?? []
  return trusted.includes(domain)
}

/**
 * Add a domain to the global config's trustedDomains list
 */
async function addTrustedDomain(domain: string): Promise<void> {
  const configPath = path.join(Global.Path.config, "opencode.json")
  const file = Bun.file(configPath)

  let text = "{}"
  if (await file.exists()) {
    text = await file.text()
  }

  // Read existing trustedDomains to append to
  const config = await Config.global()
  const existing = config.trustedDomains ?? []
  if (existing.includes(domain)) return

  const updated = [...existing, domain]

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["trustedDomains"], updated, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Bun.write(configPath, result)
  log.info("added trusted domain to global config", { domain, configPath })
}

export const RemoteSkillTool = Tool.define<typeof parameters, Record<string, unknown>>("remote-skill", {
  description: [
    "Discover and load skills from remote domains.",
    "Skills are served from /.well-known/skills/ on the domain.",
    "Use 'list' action to see available skills from a domain.",
    "Use 'load' action to fetch and use a specific skill.",
  ].join(" "),
  parameters,
  async execute(params, ctx) {
    if (params.action === "list") {
      log.info("listing remote skills", { domain: params.domain })

      const result = await RemoteSkill.fetchIndex(params.domain)
      const lines: string[] = [`## Remote Skills from ${params.domain}`, ""]

      if (result.skills.length === 0) {
        lines.push("No skills found at this domain.")
      } else {
        for (const entry of result.skills) {
          if (entry.valid) {
            const files = entry.skill.files?.length ?? 0
            const filesInfo = files > 0 ? ` (${files} additional files)` : ""
            lines.push(`- **${entry.skill.name}**: ${entry.skill.description}${filesInfo}`)
          } else {
            lines.push(`- *(invalid: ${entry.reason})* - raw: ${JSON.stringify(entry.raw)}`)
          }
        }
      }

      log.info("listed remote skills", {
        domain: params.domain,
        total: result.skills.length,
        valid: result.skills.filter((s) => s.valid).length,
        invalid: result.skills.filter((s) => !s.valid).length,
      })

      return {
        title: `Listed skills from ${params.domain}`,
        output: lines.join("\n"),
        metadata: {
          domain: params.domain,
          total: result.skills.length,
          valid: result.skills.filter((s) => s.valid).length,
        },
      }
    }

    if (params.action === "load") {
      if (!params.skill) {
        throw new Error("The 'skill' parameter is required for the 'load' action")
      }

      log.info("loading remote skill", { domain: params.domain, skill: params.skill })

      // Check if domain is trusted - if not, prompt for permission
      const trusted = await isTrustedDomain(params.domain)
      if (!trusted) {
        // Set up a one-time listener to persist trust if user chooses "always"
        const unsub = Bus.subscribe(PermissionNext.Event.Replied, async (evt) => {
          if (evt.properties.sessionID === ctx.sessionID && evt.properties.reply === "always") {
            // User chose "always", persist the domain to trustedDomains
            await addTrustedDomain(params.domain)
          }
        })

        try {
          await ctx.ask({
            permission: "remote-skill",
            patterns: [params.domain],
            always: [params.domain],
            metadata: {
              domain: params.domain,
              skill: params.skill,
              action: "load",
            },
          })
        } finally {
          unsub()
        }
      }

      // First fetch the index to get the skill entry with files array
      const index = await RemoteSkill.fetchIndex(params.domain)
      const entry = index.skills.find((s) => {
        if (s.valid) return s.skill.name === params.skill
        // Also match invalid entries by checking raw data for name
        const raw = s.raw as Record<string, unknown>
        return raw?.name === params.skill
      })

      if (!entry) {
        throw new Error(`Skill '${params.skill}' not found at ${params.domain}`)
      }

      if (!entry.valid) {
        throw new Error(`Skill '${params.skill}' at ${params.domain} is invalid: ${entry.reason}`)
      }

      // Load the skill (downloads if not cached or stale)
      const result = await RemoteSkill.load(params.domain, entry.skill)

      log.info("loaded remote skill", {
        domain: params.domain,
        skill: params.skill,
        dir: result.dir,
      })

      const lines: string[] = [
        `## Remote Skill: ${params.domain}/${params.skill}`,
        "",
        `**Description:** ${entry.skill.description}`,
        `**Cache directory:** ${result.dir}`,
        "",
        "### Skill Content",
        "",
        result.content,
      ]

      if (entry.skill.files && entry.skill.files.length > 0) {
        lines.push("", "### Additional Files", "")
        for (const file of entry.skill.files) {
          lines.push(`- \`${result.dir}/${file}\``)
        }
      }

      return {
        title: `Loaded skill ${params.domain}/${params.skill}`,
        output: lines.join("\n"),
        metadata: {
          domain: params.domain,
          skill: params.skill,
          dir: result.dir,
          files: entry.skill.files?.length ?? 0,
        },
      }
    }

    // This should never happen due to zod validation, but TypeScript needs it
    throw new Error(`Unknown action: ${params.action}`)
  },
})
