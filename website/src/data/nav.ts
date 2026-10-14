/** The primary navigation (site redesign spec §1.1, §1.5; #454): one list for the site header,
 * the docs header and the 404. GitHub follows these links as the nav's last item (GitHubLink),
 * and the genomeOS Atlas pill stands outside the nav.
 */

export interface NavLink {
  label: string;
  href: string;
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { label: 'Project', href: '/project/' },
  { label: 'Contribute', href: '/contribute/' },
  { label: 'Docs', href: '/docs/' },
];

export const GITHUB_REPOSITORY = 'https://github.com/genomeOS/genomeOS';
