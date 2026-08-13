import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

// Regenerate src/clockit.{css,js,d.ts} after editing: `npx astryx theme build src/theme.ts`
// (`npm run build` fails on stale output via `--check`).
export const clockitTheme = defineTheme({
  name: 'clockit',
  extends: neutralTheme,
  tokens: {
    '--color-accent': ['#00286E', '#8AB0FF'],
  },
});
