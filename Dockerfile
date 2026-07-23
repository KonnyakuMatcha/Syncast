FROM python:3.12-alpine

RUN apk add --no-cache openssl \
    && addgroup -S syncast \
    && adduser -S -G syncast syncast

WORKDIR /app
COPY --chown=syncast:syncast server.py ./
COPY --chown=syncast:syncast static ./static

USER syncast
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8080", "--http"]
