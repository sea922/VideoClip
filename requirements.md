# Video Editor Mini App

**Duration:** ~2 hours · **Confidential**

---

## context
Our team builds internal tools for content creators. We need a prototype that lets users clip, arrange, and export segments from YouTube videos — running reliably on constrained cloud infrastructure.

## WHAT WE NEED
Build a web application where a user can:
1. **Input a YouTube video URL** — the system downloads and makes it available for editing.
2. **Select crop positions** — choose one or more time ranges from the video.
3. **Merge clips** — combine selected segments into a single output video.
4. **Apply transition effects** — add transitions between merged segments (e.g., fade, cut, slide).

*The experience should feel complete: paste a link, select clips, export, download result.*

---

## CONSTRAINTS
* **Time budget:** ~2 hours
* **Stack preference:** NestJS, React, and/or Python — but you decide the architecture.
* **Infrastructure target:** The system must be designed to run on AWS ECS Fargate with **0.5 vCPU and 1GB RAM**. You can simulate this locally with Docker: `--memory=1g --cpus=0.5`
* **Must be runnable by our team** — Docker preferred, but any reproducible setup is acceptable.

---

## WHAT WE'LL EVALUATE
We're not looking for a specific implementation. We're looking at how you think:
* **System design:** How did you break down the problem? What tradeoffs did you make?
* **Resource management:** How does your system behave under the memory/CPU constraint? What would break first, and how did you design around it?
* **Code quality:** Is the code readable, structured, and maintainable?
* **Product sense:** Does the result actually work as a user experience?
* **Engineering judgment:** What did you choose not to build, and why?

> **Note:** Please include a short write-up (in a `README` or a separate doc) explaining your design decisions. We care as much about your reasoning as the code itself.

---

## OPEN QUESTION — SCALING
**If 1,000 users submitted videos simultaneously, what would break first in your system — and how would you fix it?**

*Write your answer in the README. There's no right