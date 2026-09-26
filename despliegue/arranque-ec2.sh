#!/bin/bash
# Arranque de la maquina que sirve la herramienta UML.
#
# Esto es "user data": cloud-init lo ejecuta como root la primera vez que la
# maquina arranca, y solo esa vez. No hay que entrar por SSH a configurar nada;
# de hecho la maquina se crea sin par de claves a proposito, para que no exista
# ninguna llave que guardar, rotar o perder. Si mas adelante hace falta mirar
# algo por dentro, se entra con Session Manager, que no usa claves ni abre el 22.
#
# Las contrasenas no viajan aqui dentro. Este fichero se lee en claro con
# `aws ec2 describe-instance-attribute --attribute userData`, asi que lo unico
# que contiene son NOMBRES de secretos. Los valores los pide la propia maquina a
# Secrets Manager al arrancar, usando su rol; nadie los teclea y no quedan en el
# historial de ninguna terminal.
set -uo pipefail

# Todo lo que sigue queda registrado. Se imprime que variable se configuro,
# nunca su valor: un registro que filtra la contrasena de la base de datos es
# peor que no tener registro.
exec > >(tee -a /var/log/arranque-uml.log) 2>&1
echo "=== arranque $(date -Is) ==="

REGION=us-east-1
CUENTA=381549360414
REGISTRO="$CUENTA.dkr.ecr.$REGION.amazonaws.com"
IMAGEN="$REGISTRO/uml-tool:v8"
ENTORNO=/etc/uml.env

dnf install -y docker
systemctl enable --now docker

# El rol de la instancia da el permiso; no hay credenciales que copiar.
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRO"

# umask antes de crear el fichero, no chmod despues: entre el `touch` y el
# `chmod` hay un instante en que el fichero es legible por todos, y es
# justo el instante en que se le escribe la contrasena dentro.
umask 077
: > "$ENTORNO"

secreto() {
  aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id "$1" --query SecretString --output text 2>/dev/null
}

# Los secretos que falten no abortan el arranque. Sin LLM_API_KEY el servicio
# funciona igual, solo con la ayuda de IA desactivada; preferimos una herramienta
# a medias y visible que una maquina que no levanta y no dice por que.
for entrada in DATABASE_URL SESSION_SECRET LLM_API_KEY; do
  valor=$(secreto "uml/$entrada")
  if [ -n "${valor:-}" ] && [ "$valor" != "None" ]; then
    printf '%s=%s\n' "$entrada" "$valor" >> "$ENTORNO"
    echo "configurado: $entrada"
  else
    echo "AUSENTE: uml/$entrada"
  fi
done

cat >> "$ENTORNO" <<'FIN'
LLM_PROVIDER=gemini
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MODEL=gemini-3.6-flash
LLM_VISION_MODEL=gemini-3.6-flash
FIN

# El 80 de la maquina al 3001 del contenedor. CloudFront habla HTTP con esta
# maquina y pone el HTTPS de cara al navegador; el certificado no vive aqui.
#
# `--restart always` es lo que hace que la herramienta vuelva sola si la maquina
# se reinicia. Este guion no se ejecuta en el segundo arranque, solo en el
# primero, asi que sin esa bandera un reinicio dejaria el servicio caido y con
# la maquina aparentemente sana.
docker rm -f uml 2>/dev/null
docker run -d --name uml --restart always -p 80:3001 --env-file "$ENTORNO" "$IMAGEN"

echo "=== fin $(date -Is) ==="
