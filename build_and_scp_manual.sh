#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/DSA_DOCKER_BUILD"
IMAGE_NAME="docksentinel-agent:manual"
TAR_NAME="docksentinel-agent-manual.tar"
TAR_PATH="${BUILD_DIR}/${TAR_NAME}"
REMOTE_TARGET="leonald@192.168.31.48:~/"

cleanup() {
  if [ -d "${BUILD_DIR}" ]; then
    echo "Cleaning temporary build artifacts..."
    rm -rf "${BUILD_DIR}"
  fi
}

trap cleanup EXIT

mkdir -p "${BUILD_DIR}"

cd "${SCRIPT_DIR}"

echo "Building Docker image: ${IMAGE_NAME}"
docker build -t "${IMAGE_NAME}" .

echo "Saving image to: ${TAR_PATH}"
docker save -o "${TAR_PATH}" "${IMAGE_NAME}"

echo "Transferring ${TAR_NAME} to ${REMOTE_TARGET}"
echo "A senha do SSH sera solicitada pelo scp, se necessario."
scp "${TAR_PATH}" "${REMOTE_TARGET}"

echo "Done."
