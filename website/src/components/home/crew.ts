/**
 * Join us, the crew's entrance (round 2 spec §4.1.6; R2-6, R2-7; #454). Imported by
 * pages/index.astro as the figure approaches (lazy chunk `crew`, ≤ 6 KB gz). One 2.2 s story on the
 * scene timeline, registered as `crew`, played once at 35% visible: each astronaut drops in from
 * above in a low-gravity hop and lands with a squash (900 ms each, 220 ms apart), picking up its
 * tool as it lands; the spot pulses once from 1.2 s; then rest. No loop, so no Pause control.
 * Under reduced motion nothing is built (the server-rendered crew is the final state).
 *
 * The newcomer who fills "Your spot" on a card's hover or focus is not part of the story: it is a
 * CSS transition on `data-filled` (home.css), so it works before this module loads and under
 * reduced motion (instantly).
 */
import type { CastId } from '../../graphics/astro/cast';
import type { PoseName } from '../../graphics/astro/poses';
import { poseTracks } from '../../graphics/astro/tracks';
import { EASE, sceneController } from '../../graphics/timeline';

export const CREW_STORY = 2200;
const STAGGER = 220;

export function initCrew(figure: HTMLElement): void {
  sceneController(
    figure,
    (tl) => {
      const layout = [
        ...figure.querySelectorAll<HTMLElement>('.crew__layout'),
      ].find((candidate) => candidate.getClientRects().length > 0);
      if (!layout) return;
      layout
        .querySelectorAll<SVGGElement>('.crew__member')
        .forEach((member, index) => {
          const root = member.querySelector('.astro');
          if (!root) return;
          const cast = member.dataset.cast as CastId;
          const pose = member.dataset.pose as PoseName;
          const t0 = index * STAGGER;
          tl.story(member, [
            [t0, { opacity: 0 }, EASE.out],
            [t0 + 160, { opacity: 1 }],
          ]);
          poseTracks(
            tl,
            'story',
            root,
            cast,
            [
              [t0, { pose: 'hop', y: -60, sq: 0.04 }, EASE.down],
              [t0 + 420, { pose, sq: -0.08 }, EASE.out],
              [t0 + 560, { pose, sq: 0.02 }, EASE.back],
              [t0 + 900, pose],
            ],
            { base: pose },
          );
        });
      // The spot waits, outlined, then pulses once as the last astronaut settles. The track holds
      // the outline's own group: `.crew__spot` stays free for the fill's CSS (data-filled).
      tl.story(layout.querySelector('.crew__spot .ghost'), [
        [1200, { opacity: 1 }, EASE.inOut],
        [1520, { opacity: 0.3 }, EASE.inOut],
        [1900, { opacity: 1 }],
      ]);
    },
    { name: 'crew', timeline: { story: CREW_STORY } },
  );
}
