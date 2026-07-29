#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
configuration=${CONFIGURATION:-debug}
product_dir="$project_root/.build/app/$configuration"
app_dir="$product_dir/InkLoop Meeting Companion.app"
contents_dir="$app_dir/Contents"

cd "$project_root"
swift build -c "$configuration" --product InkLoopMeetingCompanion
binary_dir=$(swift build -c "$configuration" --show-bin-path)

mkdir -p "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$project_root/Resources/Info.plist" "$contents_dir/Info.plist"
cp "$binary_dir/InkLoopMeetingCompanion" "$contents_dir/MacOS/InkLoopMeetingCompanion"
chmod 755 "$contents_dir/MacOS/InkLoopMeetingCompanion"

signing_identity=${INKLOOP_CODESIGN_IDENTITY:-}
if [ -z "$signing_identity" ]; then
  signing_identity=$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(AhaKey Local Dev\)".*/\1/p' \
    | head -n 1)
fi
if [ -z "$signing_identity" ]; then signing_identity=-; fi

codesign --force --deep --sign "$signing_identity" --entitlements "$project_root/InkLoopMeetingCompanion.entitlements" "$app_dir"
codesign --verify --deep --strict "$app_dir"
plutil -lint "$contents_dir/Info.plist"
echo "$app_dir"
