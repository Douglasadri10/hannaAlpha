FROM python:3.11-slim
WORKDIR /app
# dependências
COPY services/api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
# app
COPY services/api /app
# porta + start
ENV PORT=8080
EXPOSE 8080
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8080"]
