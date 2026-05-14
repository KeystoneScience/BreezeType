# GitHub Visual Assets

This folder is for durable, sanitized GitHub-facing images such as social previews, README hero images, and PR demo stills.

## Current Assets

- `breezetype-github-social.png` is the current GitHub social-preview candidate. Upload/select it in GitHub repository settings; GitHub does not automatically read social-preview images from the repo.
- `breezetype-readme-header.png` is the current README header image, supplied as reviewed launch artwork.
- `breeze-dashboard.webp` is the public product dashboard image used near the top of the README.
- `breezetype-social-background.png` is the reusable website-style background plate used by the social preview.
- `breezetype-website-macbook.png` and `breezetype-website-lockup-standard.png` are public Website asset copies used to rebuild the card without depending on the private Website repo.

## Composition Notes

The social preview is composed from public Website assets, not from an AI-generated visual style:

- source product render: `Website/public/assets/product/macbook-pro-14-breeze.png`
- source README dashboard: `https://breezetype.com/_next/image?url=%2Fassets%2Fproduct%2Fbreeze-dashboard.webp&w=3840&q=75`
- source brand lockup: `Website/public/assets/branding/breezetype-lockup-standard.png`
- source supporting visuals: `Website/public/assets/marketing/local-orbit.png` and `Website/public/assets/marketing/workflow-cluster.png`

Keep drafts in ignored local folders and move only reviewed final assets here. Do not commit screenshots containing transcripts, recordings, email addresses, provider keys, private URLs, or Website/Server admin surfaces.
