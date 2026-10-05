---
name: sprint-planner
description: Plan the incremental development of a user's request by writing only sprint documents (goal, acceptance criteria, technical tasks, tests), without writing code. Use this skill when the user asks for a sprint plan, development planning, or a development backlog.
---

# Sprint Planner

You must plan the incremental development of the user's requests. Nothing must be implemented; only sprint files must be written.

---

## Your team

Create a team of agents with 3 specialized roles that collaborate to produce a sprint plan.

### 🎯 Product Owner (PO)

**Responsibilities:**
- Defines the **scope of each sprint** by selecting features from the architecture document
- Sets **priorities**: what to develop first and what to defer
- Writes the **acceptance criteria** for each sprint (what must work for the sprint to be considered "done")
- Verifies that the sprint can be **tested independently by the user**
- Ensures that each sprint delivers **visible, usable progress**, never "invisible" code

**The PO's fundamental rule:** Each sprint must be small enough for the user to test manually before moving on to the next one. The user must be able to say "it works" or "it doesn't work" without reading the code.

### 🏗️ Tech Lead (TL)

**Responsibilities:**
- Discusses the PO's decisions with them and translates those decisions into concrete **technical tasks** (files to create/modify, functions to implement)
- Defines the **implementation order** of tasks within the sprint (technical dependencies)
- Specifies the **files involved** in each task, labeled [NEW], [MODIFY], or [DELETE]
- Identifies **dependencies** on existing code (models, services, templates in `workflows/`)
- Defines the required **automated tests** and the commands to run them
- Ensures that each sprint **does not break** existing functionality

**The TL's fundamental rule:** Technical tasks must be specific enough for another AI agent to execute them without ambiguity.

### 👥 Development Team (Dev)

**Composition (decided by the TL for each sprint):**
- **Backend Developer** — Django models, services, admin views
- **Frontend Developer** — HTML templates, CSS, JavaScript

Not every role is needed in every sprint. The TL decides whom to involve.

**Responsibilities:**
- Executes the technical tasks defined by the TL
- Flags problems or ambiguities before making assumptions

---

## How to work: the sprint cycle

The agents must communicate with one another to arrive at a sprint plan that meets the user's requests and leaves no ambiguity.

**Output:** a sprint document at `sprints/{{yyyy-mm-dd}}/{{appropriate-name-for-the-implementation}}/sprint_XX.md`

---

## Sprint document format

Each sprint must be documented using the structure in `references/sprint-example.md`.

---

## Sprint backlog (initial proposal)

> [!IMPORTANT]
> This is an initial proposal from the PO. The user may ask to reorder, merge, or split the sprints. The goal is to keep sprints small and testable.
