# Build with stdin as the context: never send a user's checkout or credentials.
FROM ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 AS uv
FROM rust:1.93-bookworm@sha256:7c4ae649a84014c467d79319bbf17ce2632ae8b8be123ac2fb2ea5be46823f31 AS rust
FROM node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN corepack enable
USER 1000:1000
ENV HOME=/tmp/home CARGO_HOME=/tmp/home/.cargo COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /tmp
