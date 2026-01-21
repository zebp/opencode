import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { RemoteSkill } from "../skill/remote"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"
import { Config } from "../config/config"
import { Global } from "../global"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { modify, applyEdits } from "jsonc-parser"

const log = Log.create({ service: "tool.skill" })

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

export const SkillTool = Tool.define("skill", async (ctx) => {
  const skills = await Skill.all()

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

  const description =
    accessibleSkills.length === 0
      ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
      : [
          "Load a skill to get detailed instructions for a specific task.",
          "Skills provide specialized knowledge and step-by-step guidance.",
          "Use this when a task matches an available skill's description.",
          "Only the skills listed here are available:",
          "<available_skills>",
          ...accessibleSkills.flatMap((skill) => [
            `  <skill>`,
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `  </skill>`,
          ]),
          "</available_skills>",
        ].join(" ")

  const examples = accessibleSkills
    .map((skill) => `'${skill.name}'`)
    .slice(0, 3)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().describe(`The skill identifier from available_skills${hint}`),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Check if this is a namespaced remote skill (e.g., cloudflare.com/wrangler)
      const parsed = RemoteSkill.parseNamespace(params.name)

      if (parsed) {
        // This is a remote skill request - load from remote
        log.info("loading remote skill via skill tool", { domain: parsed.domain, skill: parsed.skill })

        // Check if domain is trusted - if not, prompt for permission
        const trusted = await isTrustedDomain(parsed.domain)
        if (!trusted) {
          // Set up a one-time listener to persist trust if user chooses "always"
          const unsub = Bus.subscribe(PermissionNext.Event.Replied, async (evt) => {
            if (evt.properties.sessionID === ctx.sessionID && evt.properties.reply === "always") {
              await addTrustedDomain(parsed.domain)
            }
          })

          try {
            await ctx.ask({
              permission: "remote-skill",
              patterns: [parsed.domain],
              always: [parsed.domain],
              metadata: {
                domain: parsed.domain,
                skill: parsed.skill,
                action: "load",
              },
            })
          } finally {
            unsub()
          }
        }

        // Fetch the index to get the skill entry
        const index = await RemoteSkill.fetchIndex(parsed.domain)
        const entry = index.skills.find((s) => {
          if (s.valid) return s.skill.name === parsed.skill
          // Also match invalid entries by checking raw data for name
          const raw = s.raw as Record<string, unknown>
          return raw?.name === parsed.skill
        })

        if (!entry) {
          throw new Error(`Remote skill '${parsed.skill}' not found at ${parsed.domain}`)
        }

        if (!entry.valid) {
          throw new Error(`Remote skill '${parsed.skill}' at ${parsed.domain} is invalid: ${entry.reason}`)
        }

        // Load the skill (downloads if not cached or stale)
        const result = await RemoteSkill.load(parsed.domain, entry.skill)

        log.info("loaded remote skill", {
          domain: parsed.domain,
          skill: parsed.skill,
          dir: result.dir,
        })

        // Parse the markdown content
        const md = await ConfigMarkdown.parse(path.join(result.dir, "SKILL.md"))

        const lines: string[] = [
          `## Skill: ${parsed.domain}/${parsed.skill}`,
          "",
          `**Base directory**: ${result.dir}`,
          "",
          md.content.trim(),
        ]

        if (entry.skill.files && entry.skill.files.length > 0) {
          lines.push("", "### Additional Files", "")
          for (const file of entry.skill.files) {
            lines.push(`- \`${result.dir}/${file}\``)
          }
        }

        return {
          title: `Loaded skill: ${parsed.domain}/${parsed.skill}`,
          output: lines.join("\n"),
          metadata: {
            name: params.name,
            dir: result.dir,
          },
        }
      }

      // Not namespaced - load local skill only
      const skill = await Skill.get(params.name)

      if (!skill) {
        const available = await Skill.all().then((x) => x.map((s) => s.name).join(", "))
        throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })
      // Load and parse skill content
      const md = await ConfigMarkdown.parse(skill.location)
      const dir = path.dirname(skill.location)

      // Format output similar to plugin pattern
      const output = [`## Skill: ${skill.name}`, "", `**Base directory**: ${dir}`, "", md.content.trim()].join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})
