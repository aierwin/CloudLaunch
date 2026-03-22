# CloudLaunch

Deploy static websites to AWS with just a few clicks. No command line needed.

CloudLaunch is a Mac desktop app that handles all the AWS setup for you — it creates an S3 bucket for your files, sets up a CloudFront CDN for fast global delivery, and gives you a live URL. All you need is an AWS account.

## Quick Start

1. **Download** the latest `.dmg` from the [Releases](https://github.com/aierwin/CloudLaunch/releases) page
2. Open the DMG and drag CloudLaunch to your Applications folder
3. Launch the app and enter your AWS credentials
4. Pick a project name, select your website folder, and hit Deploy

Your site will be live on a CloudFront URL within minutes.

## What You'll Need

- A Mac (Apple Silicon)
- An AWS account with an Access Key ID and Secret Access Key
- A folder with your website files (HTML, CSS, JS, images, etc.)

## Features

- **One-click deployment** — guided step-by-step wizard walks you through everything
- **Deployment dashboard** — see all your sites in one place with live status
- **Update anytime** — push changes to an existing deployment and the CDN cache refreshes automatically
- **Secure credentials** — your AWS secret key is encrypted using the macOS Keychain
- **Multi-region support** — deploy to 12 different AWS regions
- **Full cleanup** — remove a deployment and CloudLaunch deletes all the AWS resources it created
- **Open in editor** — jump to your project folder in Finder, VS Code, or Cursor

## How It Works

When you deploy a site, CloudLaunch:

1. Creates an S3 bucket configured for static website hosting
2. Uploads all your website files with the correct content types
3. Creates a CloudFront distribution pointed at the bucket
4. Gives you the CloudFront URL where your site is live

When you update a deployment, it re-uploads your files and automatically invalidates the CDN cache so changes go live quickly.

## AWS Permissions

Your AWS credentials need permissions for:

- **S3** — create/delete buckets, upload/delete objects, set bucket policies
- **CloudFront** — create/update/delete distributions, create cache invalidations

A user with the `AmazonS3FullAccess` and `CloudFrontFullAccess` managed policies will work.

## Uninstalling

1. Delete CloudLaunch from your Applications folder
2. Optionally remove stored data at `~/Library/Application Support/CloudLaunch/`

**Note:** Uninstalling the app does not remove any AWS resources you've created. Use the app's delete feature to clean those up first.

## License

MIT
