FROM python:3-alpine

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY pi_dash/ ./pi_dash/
COPY web/ ./web/

RUN addgroup -S pidash && adduser -S pidash -G pidash && chown -R pidash:pidash /app
USER pidash

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/health', timeout=3)" || exit 1

# MUST stay at one worker: caches, Pi-hole sessions and locks are in-process.
# More workers split caches and multiply Pi-hole logins and v6 API seats.
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--workers", "1", "--threads", "4", "--timeout", "30", "pi_dash.app:app"]
