# CardRoomPro UI Audit Notes

Date: 2026-07-04
Local URL: http://127.0.0.1:8012/

## Captured Steps

1. Guest login, desktop and mobile.
2. Lobby, desktop and mobile.
3. Rules modal and stats modal.
4. Doudizhu room waiting state.
5. Doudizhu AI playing state.
6. Guandan lobby.
7. Guandan waiting state.
8. Guandan AI playing state.
9. Mobile portrait room landscape lock.

## Fixed Issues

- Undefined theme variables caused some themed colors and borders to fall back or be dropped.
- Entering a room accessed the removed `msgSelect` ref and produced a Vue runtime error.
- The document language was declared as English although the UI is Chinese.
- Mobile guest login could push the submit button outside the login panel.
- Mobile top navigation could wrap Chinese button text or clip the last action.

## Verification

- Re-ran desktop guest login, lobby, modals, Doudizhu waiting, Doudizhu AI game, Guandan waiting, and Guandan AI game.
- Re-ran mobile guest login, lobby, and portrait room lock at 390px width.
- Checked inline scripts and Node files with syntax validation.
- Rechecked CSS custom properties; no unresolved theme variables remain, ignoring the intentional `--i` animation fallback.
