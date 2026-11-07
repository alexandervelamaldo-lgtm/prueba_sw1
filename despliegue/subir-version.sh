#!/bin/bash
# Subir una version nueva a la que ya esta corriendo en AWS.
#
# El despliegue inicial esta en docs/06-despliegue.md §6.4. Esto es lo otro: el
# relevo, que es lo que se hace de verdad una y otra vez y que no estaba escrito
# en ningun sitio. La primera vez se hizo a mano, y a mano se olvida siempre el
# mismo paso —el de abajo, el numero 4—.
#
# No crea nada. La maquina, la distribucion, la base de datos y los secretos ya
# existen y este guion no los toca: solo cambia la imagen que corre dentro del
# contenedor. Si algo de la infraestructura hay que rehacerlo, es el otro
# documento.
#
#   Uso:  ./despliegue/subir-version.sh v3
#
# Se pide la etiqueta a mano y no se calcula sola a proposito. Reusar la misma
# etiqueta para dos imagenes distintas es la forma mas rapida de no saber nunca
# que hay corriendo en la maquina: `docker pull` de una etiqueta que ya esta en
# la cache local no baja nada, y el contenedor sigue con la de antes mientras el
# registro dice otra cosa.
set -euo pipefail

ETIQUETA="${1:-}"
if [ -z "$ETIQUETA" ]; then
  echo "Falta la etiqueta. Mira las que ya existen y usa la siguiente:" >&2
  echo "  aws ecr describe-images --repository-name uml-tool --region us-east-1 \\" >&2
  echo "      --query 'imageDetails[].imageTags' --output text" >&2
  exit 2
fi

REGION=us-east-1
INSTANCIA=i-06a55ec56a5bdde65
DISTRIBUCION=E3STT8GNT4N7V3
SITIO=https://d2kpdlaikoc7bc.cloudfront.net

# El numero de cuenta se pregunta, no se escribe. Un identificador de cuenta
# pegado en un fichero del repositorio es lo que hace que el guion funcione solo
# en el portatil de quien lo escribio.
CUENTA=$(aws sts get-caller-identity --query Account --output text)
REGISTRO="$CUENTA.dkr.ecr.$REGION.amazonaws.com"
IMAGEN="$REGISTRO/uml-tool:$ETIQUETA"

echo "== 1/6 pruebas =="
# Antes de construir, no despues. Construir la imagen son varios minutos y subir
# 1,5 GB otros tantos: descubrir el fallo al final significa haberlos gastado.
npx vitest run

echo "== 2/6 construir $IMAGEN =="
# `--platform linux/amd64` no es opcional aunque el portatil sea Intel: Docker
# Desktop construye para la plataforma del anfitrion, y una imagen arm64 en una
# EC2 x86 no falla al subirse —falla al arrancar, en la maquina, con un
# «exec format error» que no se parece en nada a su causa.
#
# El frontend se construye dentro de la imagen (Dockerfile, etapa 1), asi que no
# hay que acordarse de `npm run build` antes: lo que se despliega es lo que hay
# en el arbol de trabajo, no lo que quedo en `frontend/dist` de la ultima vez.
docker build --platform linux/amd64 -t "uml-tool:$ETIQUETA" .

echo "== 3/6 subir a ECR =="
# El testigo va por la tuberia directo a `docker login`: no se escribe en ningun
# fichero ni queda en el historial del shell.
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRO"
docker tag "uml-tool:$ETIQUETA" "$IMAGEN"
docker push "$IMAGEN"

echo "== 4/6 apuntar el arranque a $ETIQUETA =="
# El paso que se olvida. `arranque-ec2.sh` es el «user data» de la maquina: lo
# ejecuta cloud-init una sola vez, en el primer arranque, y ahi dentro esta
# escrita la etiqueta de la imagen. Si no se actualiza, el despliegue funciona
# —el contenedor se releva mas abajo— pero la maquina queda armada para volver a
# la version vieja el dia que alguien la reinicie. Y ese dia nadie relaciona una
# regresion con un reinicio de hace tres semanas.
#
# Se cambia el fichero del repositorio; subirlo a la instancia es otra cosa y va
# aparte, porque cambiar el user data de una maquina encendida exige pararla.
# Mientras no se haga, este fichero es al menos la verdad escrita.
sed -i -E "s|(uml-tool:)v[0-9]+|\1$ETIQUETA|" despliegue/arranque-ec2.sh
grep -n "uml-tool:" despliegue/arranque-ec2.sh

echo "== 5/6 relevar el contenedor en la maquina =="
# Por SSM y no por SSH: la maquina se creo sin par de claves a proposito, para
# que no exista ninguna llave que guardar, rotar o perder.
#
# El `--env-file /etc/uml.env` que ya esta en la maquina se reusa tal cual. Los
# secretos no se vuelven a pedir ni pasan por aqui: siguen donde los dejo el
# arranque, escritos con umask 077 y sin salir nunca de ese fichero.
#
# El orden importa: `pull` primero y `rm -f` despues. Al reves, el servicio se
# queda caido durante todo lo que tarde la descarga de 1,5 GB, y si la descarga
# falla se queda caido del todo.
ORDEN=$(aws ssm send-command \
  --region "$REGION" \
  --instance-ids "$INSTANCIA" \
  --document-name AWS-RunShellScript \
  --comment "relevo a $ETIQUETA" \
  --parameters "commands=[
    \"set -e\",
    \"aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRO\",
    \"docker pull $IMAGEN\",
    \"docker rm -f uml || true\",
    \"docker run -d --name uml --restart always -p 80:3001 --env-file /etc/uml.env $IMAGEN\",
    \"sleep 12\",
    \"curl -sf http://127.0.0.1/salud\",
    \"docker image prune -af\"
  ]" \
  --query Command.CommandId --output text)

echo "orden $ORDEN"
aws ssm wait command-executed --region "$REGION" \
  --command-id "$ORDEN" --instance-id "$INSTANCIA" || true
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$ORDEN" --instance-id "$INSTANCIA" \
  --query "{Estado:Status,Salida:StandardOutputContent,Error:StandardErrorContent}" \
  --output text

# `image_prune` al final de la orden, y no antes del `run`: en una maquina con
# 8 GB de disco, tres versiones de una imagen de 1,5 GB la llenan, y el sintoma
# es un `docker pull` que falla por falta de espacio justo cuando hay prisa.

echo "== 6/6 invalidar la cache y comprobar =="
# CloudFront cachea el `index.html` y los ficheros con hash en el nombre. Los
# segundos no hace falta invalidarlos —cambian de nombre en cada build— pero el
# primero si: sin esto, el navegador sigue pidiendo el bundle viejo por su
# nombre viejo, que ya no esta en la maquina, y la web se queda en blanco con un
# 404 en la consola. Es el fallo que parece «el despliegue rompio algo».
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUCION" --paths "/*" \
  --query "Invalidation.{Id:Id,Estado:Status}" --output text

curl -sS "$SITIO/salud"; echo
echo "Comprueba a mano: $SITIO  y  $SITIO/movil"
