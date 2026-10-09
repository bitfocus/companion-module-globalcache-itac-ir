# Latest release README template

This repository's workflow updates the `Latest release` section whenever a
GitHub release is published. To use it in another repository:

1. Copy `.github/workflows/update-latest-release.yml` into that repository.
2. Add one pair of these markers to its `README.md`, where the release link
   should appear:

   ```markdown
   <!-- latest-release:start -->
   No releases published yet.
   <!-- latest-release:end -->
   ```

3. Ensure the repository allows GitHub Actions to write repository contents
   (Settings > Actions > General > Workflow permissions). The workflow grants
   itself `contents: write`; branch protection must also allow this workflow to
   push to the default branch.

The workflow runs for published releases, replaces only the text between the
markers, and commits the release tag, publication date, and release-notes link
to the default branch. If the markers are missing or duplicated, the workflow
fails instead of changing the wrong part of the README.
