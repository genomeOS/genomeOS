/** The primary navigation (site redesign spec §1.1, §1.5; round 2 spec §1.1, R2-4; #454): one list
 * for the site header, the docs header and the 404. GitHub follows these links as the nav's last
 * item (GitHubLink), and the genomeOS Atlas pill stands outside the nav. Contact joins the list
 * after Docs (Contact page spec §1).
 */

export interface NavLink {
  label: string;
  href: string;
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { label: 'Projects', href: '/projects/' },
  { label: 'Contribute', href: '/contribute/' },
  { label: 'Docs', href: '/docs/' },
  { label: 'Contact', href: '/contact/' },
];

export const GITHUB_REPOSITORY = 'https://github.com/genomeOS/genomeOS';
