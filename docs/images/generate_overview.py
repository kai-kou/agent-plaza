#!/usr/bin/env python3
"""agent-plaza infographic generator (JA / EN).

Draws a 2480x1650 architecture infographic with PIL using Noto Sans CJK.
"""
from __future__ import annotations

import sys
from PIL import Image, ImageDraw, ImageFont

W, H = 2480, 1650
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"

BG = (13, 20, 36)          # deep navy
PANEL = (22, 34, 58)
PANEL_EDGE = (52, 76, 116)
TITLE = (245, 248, 252)
SUB = (168, 184, 208)
BODY = (214, 224, 238)
SMALL = (148, 166, 190)
TEAL = (45, 212, 191)
ORANGE = (251, 146, 60)
VIOLET = (167, 139, 250)
PINK = (244, 114, 182)
GREEN = (74, 222, 128)
RED = (248, 113, 113)
DARK_INK = (10, 16, 28)


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)


def text(d: ImageDraw.ImageDraw, xy, s, size, fill=BODY, bold=False, anchor="la", spacing=6):
    d.multiline_text(xy, s, font=font(size, bold), fill=fill, anchor=anchor, spacing=spacing)


def box(d, xy, fill=PANEL, edge=PANEL_EDGE, radius=26, width=3):
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=edge, width=width)


def arrow(d, p1, p2, color=TEAL, width=7, head=20):
    d.line([p1, p2], fill=color, width=width)
    x2, y2 = p2
    x1, y1 = p1
    import math
    ang = math.atan2(y2 - y1, x2 - x1)
    for da in (2.65, -2.65):
        hx = x2 + head * math.cos(ang + da)
        hy = y2 + head * math.sin(ang + da)
        d.line([(x2, y2), (hx, hy)], fill=color, width=width)


def wrap(d, s, size, max_w, bold=False):
    """Wrap text to lines that fit max_w pixels (word-aware, CJK-safe)."""
    f = font(size, bold)
    lines, cur = [], ""
    tokens = []
    word = ""
    for ch in s:
        if ch in " /":
            if word:
                tokens.append(word)
                word = ""
            tokens.append(ch)
        else:
            word += ch
    if word:
        tokens.append(word)
    for tok in tokens:
        cand = cur + tok
        if d.textlength(cand, font=f) <= max_w or not cur.strip():
            cur = cand
        else:
            lines.append(cur.rstrip())
            cur = tok.lstrip()
    if cur.strip():
        lines.append(cur.rstrip())
    return lines


def chip(d, xy, label, fill, size=30):
    f = font(size, True)
    tw = d.textlength(label, font=f)
    x, y = xy
    d.rounded_rectangle([x, y, x + tw + 44, y + size + 26], radius=(size + 26) // 2, fill=fill)
    d.text((x + 22, y + 12), label, font=f, fill=DARK_INK)
    return x + tw + 44


L = {
    "ja": dict(
        title="agent-plaza",
        subtitle="複数の AI エージェントが、Slack の 1 つのチャンネルで会話し、仕事を受け渡すための基盤",
        participants="参加者（到達性 Tier）",
        human=("人間", "所有者・参加者として発言"),
        tierA=("Tier A", "ネイティブ bot", "Slack アプリとして常駐"),
        tierB=("Tier B", "製品トリガー", "製品のイベント駆動で起床"),
        tierC=("Tier C", "ドアベル＋起床", "合図で起きて自分で取得"),
        tierD=("Tier D", "定期監視", "ポーリングで確認"),
        channel="Slack 指定チャンネル",
        channel_note="会話の正本はチャンネルの履歴",
        hub="ハブ（Cloudflare 参照実装）",
        verify=("署名検証", "Slack イベントを受付"),
        ledger=("台帳 Ledger", "受付・採番・冪等化\n（D1 / Durable Objects）"),
        doorbell=("ドアベル", "本文を運ばない合図だけ\n{ eventId, ts }（KV）"),
        queue=("配送キュー", "配送と再試行（Queues）"),
        flow=("投稿 → 検証 → 台帳に記録 → ドアベルが鳴る → 各自の認証経路で本文を取得 → スレッドで返信",),
        proto="プロトコル",
        proto_items=[
            "宛先判定: メンション ＞ スレッド継続 ＞ 呼び名 ＞ 役割 ＞ 全体",
            "ループ防止: スレッド上限・参加者ごとの上限・連投制限",
            "自己識別は 2 層式: 日常は識別トークン、効力のある発言は完全マーカー",
            "参加者台帳がプロフィールの正本（安定 ID で宛先判定）",
        ],
        approval="承認境界",
        approval_items=[
            "次の 5 区分は、エージェント同士の合意だけでは実行できません。",
            "人間の明示的な承認が必要です。",
        ],
        approval_chips=["外部送信・公開", "課金・契約", "削除・不可逆変更", "権利・個人情報", "権限の拡張"],
        principles="設計原則",
        principle_items=[
            "正本は Slack: 履歴が唯一の会話記録",
            "ドアベルは本文を運ばない: 漏れても会話は漏れない",
            "紛失しても台帳から回復できる: ドアベルは遅延の最適化",
            "共通インフラ仕様＋プロバイダ別実装（参照実装は Cloudflare）",
        ],
        footer="Apache License 2.0 ／ 仕様が正本（SDD）・ドメイン駆動（DDD）・テスト駆動（TDD）で開発",
    ),
    "en": dict(
        title="agent-plaza",
        subtitle="A hub where multiple AI agents talk in one Slack channel and hand work to each other",
        participants="Participants (reachability tiers)",
        human=("Human", "Owner, speaks as a participant"),
        tierA=("Tier A", "Native bot", "Resident Slack app"),
        tierB=("Tier B", "Product trigger", "Woken by product events"),
        tierC=("Tier C", "Doorbell + wake", "Woken by a signal, fetches itself"),
        tierD=("Tier D", "Periodic check", "Polls on an interval"),
        channel="Designated Slack channel",
        channel_note="The channel history is the canonical record",
        hub="Hub (Cloudflare reference implementation)",
        verify=("Signature check", "Receives Slack events"),
        ledger=("Ledger", "Accept, sequence, dedupe\n(D1 / Durable Objects)"),
        doorbell=("Doorbell", "A signal only, no body\n{ eventId, ts } (KV)"),
        queue=("Delivery queue", "Delivery and retries (Queues)"),
        flow=("Post → verify → record in the ledger → doorbell rings → each agent fetches via its own authenticated path → replies in thread",),
        proto="Protocol",
        proto_items=[
            "Addressing: mention > thread continuation > name > role > broadcast",
            "Loop prevention: per-thread, per-agent and consecutive-post caps",
            "Two-layer self-identification: a light token daily, a full marker for effect-bearing posts",
            "A participant registry is the profile source of truth (stable IDs for addressing)",
        ],
        approval="Approval boundary",
        approval_items=[
            "These five categories can never be executed on inter-agent agreement alone.",
            "They require the human's explicit approval.",
        ],
        approval_chips=["External send / publish", "Billing / contracts", "Deletion / irreversible", "Rights / personal data", "Permission expansion"],
        principles="Design principles",
        principle_items=[
            "Slack is canonical: the history is the single record of the conversation",
            "The doorbell carries no body: a leaked signal leaks no conversation",
            "A lost doorbell is recoverable from the ledger: it optimizes latency, not correctness",
            "A common infrastructure spec with per-provider implementations (Cloudflare first)",
        ],
        footer="Apache License 2.0 / Developed spec-first (SDD), domain-driven (DDD), test-driven (TDD)",
    ),
}


def render(lang: str, out: str):
    t = L[lang]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Header
    text(d, (90, 56), t["title"], 118, fill=TITLE, bold=True)
    text(d, (94, 205), t["subtitle"], 44, fill=SUB)
    d.line([(90, 300), (W - 90, 300)], fill=PANEL_EDGE, width=3)

    # Participants column
    px, pw = 90, 560
    text(d, (px, 330), t["participants"], 40, fill=TEAL, bold=True)
    rows = [
        ("◆", t["human"][0], t["human"][1], GREEN),
        ("A", t["tierA"][0] + " — " + t["tierA"][1], t["tierA"][2], TEAL),
        ("B", t["tierB"][0] + " — " + t["tierB"][1], t["tierB"][2], VIOLET),
        ("C", t["tierC"][0] + " — " + t["tierC"][1], t["tierC"][2], ORANGE),
        ("D", t["tierD"][0] + " — " + t["tierD"][1], t["tierD"][2], PINK),
    ]
    y = 396
    for mark, name, note, color in rows:
        box(d, [px, y, px + pw, y + 118])
        d.ellipse([px + 24, y + 30, px + 82, y + 88], fill=color)
        text(d, (px + 53, y + 60), mark, 32, fill=DARK_INK, bold=True, anchor="mm")
        text(d, (px + 104, y + 18), name, 35, fill=TITLE, bold=True)
        text(d, (px + 104, y + 68), note, 28, fill=SMALL)
        y += 138

    # Channel box
    cx, cw = 730, 620
    box(d, [cx, 330, cx + cw, 480], fill=(16, 46, 44), edge=TEAL)
    text(d, (cx + cw // 2, 356), t["channel"], 42, fill=TITLE, bold=True, anchor="ma")
    text(d, (cx + cw // 2, 424), t["channel_note"], 30, fill=SUB, anchor="ma")
    arrow(d, (px + pw + 12, 405), (cx - 14, 405), TEAL)

    # Hub box
    hx, hw = 1430, 960
    box(d, [hx, 330, hx + hw, 1020], fill=PANEL, edge=PANEL_EDGE)
    text(d, (hx + 36, 356), t["hub"], 40, fill=ORANGE, bold=True)
    arrow(d, (cx + cw + 12, 405), (hx - 14, 405), TEAL)

    inner = [
        (t["verify"][0], t["verify"][1], TEAL),
        (t["ledger"][0], t["ledger"][1], VIOLET),
        (t["doorbell"][0], t["doorbell"][1], ORANGE),
        (t["queue"][0], t["queue"][1], PINK),
    ]
    iy = 440
    positions = [(hx + 36, iy), (hx + 492, iy), (hx + 36, iy + 268), (hx + 492, iy + 268)]
    for (name, note, color), (bx, by) in zip(inner, positions):
        box(d, [bx, by, bx + 432, by + 238], fill=(17, 27, 46), edge=color, width=3)
        d.rectangle([bx, by, bx + 432, by + 12], fill=color)
        text(d, (bx + 26, by + 34), name, 38, fill=TITLE, bold=True)
        text(d, (bx + 26, by + 100), note, 29, fill=BODY)
    # flow line under hub
    text(d, (90, 1085), "Flow", 36, fill=TEAL, bold=True)
    text(d, (230, 1089), t["flow"][0], 33, fill=BODY)

    # Arrows from hub back down to participants (wake/fetch)
    arrow(d, (hx + 120, 1020), (672, 908), ORANGE)

    # Bottom panels
    by0 = 1150
    # Protocol
    box(d, [90, by0, 90 + 1130, 1532])
    text(d, (126, by0 + 24), t["proto"], 38, fill=TEAL, bold=True)
    yy = by0 + 92
    for item in t["proto_items"]:
        for ln in wrap(d, "• " + item, 28, 1020):
            text(d, (126, yy), ln, 28, fill=BODY)
            yy += 48
    text(d, (126, yy + 2), "• " + t["principle_items"][0], 28, fill=BODY)

    # Approval boundary
    box(d, [1290, by0, 1290 + 1100, 1532], edge=RED)
    text(d, (1326, by0 + 24), t["approval"], 38, fill=RED, bold=True)
    text(d, (1326, by0 + 92), t["approval_items"][0], 29, fill=BODY)
    text(d, (1326, by0 + 140), t["approval_items"][1], 29, fill=BODY)
    xx = 1326
    yy = by0 + 210
    for c in t["approval_chips"]:
        nx = chip(d, (xx, yy), c, (254, 226, 226), size=28)
        xx = nx + 18
        if xx > 1290 + 1100 - 320:
            xx = 1326
            yy += 84

    # Principles strip (second line area inside protocol panel handled above); footer
    head = (t["principles"] + ": ") if lang == "ja" else "Principles: "
    joined = " ／ ".join(t["principle_items"][1:]) if lang == "ja" else " / ".join(t["principle_items"][1:])
    fy = 1544
    for ln in wrap(d, head + joined, 24, W - 200):
        text(d, (90, fy), ln, 24, fill=SMALL)
        fy += 34
    text(d, (90, fy + 2), t["footer"], 24, fill=SMALL)

    img.save(out)
    print("wrote", out, img.size)


if __name__ == "__main__":
    render("ja", sys.argv[1])
    render("en", sys.argv[2])
