```
┌ Which CLI?   api ─────────────────────────┐
│ ✨ Claude Code          new           🕘  │
│ 🚀 Codex                new           🕘  │
│ ⭐ Gemini               new           🕘  │
└───────────────────────────────────────────┘
```

`Enter` launches with the default mode. The **🕘** button launches the other one —
resuming the CLI's previous conversation instead of starting fresh.

Agentry never stores conversation state itself. It only decides whether to
pass `--continue`, `resume --last` or nothing at all; everything after that
belongs to the CLI.
