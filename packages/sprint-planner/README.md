# Pi Sprint Planner

A Pi skill for planning small, user-testable development sprints without implementing code. Plans include acceptance criteria, ordered technical tasks, automated checks, and manual testing instructions.

## Install locally

```bash
pi install /home/spugna/pi-packages/packages/sprint-planner
```

Run `/reload` in an existing Pi session, then use:

```text
/skill:sprint-planner Plan development sprints for this feature.
```

The skill and its sprint template are written in English. The skill provides instructions, not a multi-agent runtime; separate agents require host support.

## Future npm distribution

The package name is `@capa00/pi-sprint-planner`. After publication, installation will be:

```bash
pi install npm:@capa00/pi-sprint-planner
```

Before publishing, confirm the license and authorship, review the skill for portability, and inspect the package contents:

```bash
npm pack --dry-run
```

This package has no runtime dependencies. Local installation does not publish anything to npm.
