// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseMemoryFile } from "../src/importers";

describe("parseMemoryFile", () => {
  it("turns CLAUDE.md bullets into notes with their heading as context", () => {
    const md = `# CLAUDE.md

Personal rules for every repository.

## Git
- Never add co-author trailers to commits.
- Use conventional commit subjects
  that stay under 72 characters.

## Testing
1. Run npm test before pushing.
   - also run the type check
- [x] Keep fixtures small.

\`\`\`sh
npm test
\`\`\`
`;
    expect(parseMemoryFile(md, "claude-md")).toEqual([
      "Personal rules for every repository.",
      "Git: Never add co-author trailers to commits.",
      "Git: Use conventional commit subjects that stay under 72 characters.",
      "Testing: Run npm test before pushing. also run the type check",
      "Testing: Keep fixtures small.",
      "Testing: ```sh\nnpm test\n```",
    ]);
  });

  it("splits Hermes memory files on the section sign", () => {
    const hermes = "User prefers German in chat\nand English in code.\n§\nThe home server runs Proxmox.\n§\n\n§\nok\n";
    expect(parseMemoryFile(hermes, "hermes")).toEqual(["User prefers German in chat and English in code.", "The home server runs Proxmox."]);
  });

  it("turns a pasted ChatGPT memory list into one note per line, without bullets or dates", () => {
    const list = `- 2025-03-14 Prefers TypeScript over JavaScript.
2024-11-02: Runs the tests before every commit.

* Likes short commit messages
1. 14 Mar 2025 Keeps notes in Obsidian
- short
- Prefers TypeScript over JavaScript.
`;
    expect(parseMemoryFile(list, "chatgpt")).toEqual([
      "Prefers TypeScript over JavaScript.",
      "Runs the tests before every commit.",
      "Likes short commit messages",
      "Keeps notes in Obsidian",
    ]);
    expect(parseMemoryFile(list, "gemini")).toEqual(parseMemoryFile(list, "chatgpt"));
  });

  it("falls back to Markdown when a Hermes file has no separators and drops duplicates", () => {
    expect(parseMemoryFile("- Likes short replies.\n- likes short replies.\n- Uses Cloudflare.", "hermes")).toEqual([
      "Likes short replies.",
      "Uses Cloudflare.",
    ]);
  });
});
