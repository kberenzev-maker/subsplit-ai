# Client Release & In-App Update Protocol

Whenever changes to the SubSplit AI codebase are completed (features, bug fixes, UI adjustments, or refactorings), follow this strict protocol:

1. **Explicit Permission Required**:
   - Never run `git push origin main` or update `version.json` automatically without user confirmation.
   - Always ask: «Пушим обновление для всех клиентов?» along with proposed version bump and release notes.

2. **Trigger Commands**:
   - Explicit commands from user: `/release`, «пушим», «выкати», «обнови плагин», «сделай релиз», «деплой».
   - Implicit trigger: completion of any actionable coding task.

3. **Execution Steps upon Approval**:
   - Bump `version` and `build` in `version.json`.
   - Update `description` in `version.json` with user-facing summary of improvements.
   - Run `git add . && git commit -m "release: vX.X.X - ..." && git push origin main`.
   - Report success to user.
