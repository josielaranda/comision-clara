# Comisión Clara

Aplicación web instalable para llevar comisiones de vendedores y los abonos que reciben. Está hecha con HTML, CSS y JavaScript sin dependencias de instalación; puedes editarla con Acode y publicarla gratis con GitHub Pages.

## Qué puedes llevar

- Vendedores y productos, con una comisión fija por unidad para cada producto.
- Registros por vendedor y producto, cantidad, fecha y nota opcional.
- Pagos completos o abonos, con historial cronológico editable; el saldo se recalcula automáticamente y un pago no puede superar lo pendiente.
- Resumen total y por vendedor, búsqueda y filtros.
- Exportación de respaldo JSON y descarga de comisiones CSV.
- Montos en pesos mexicanos (MXN) y fechas visibles en formato dd/mm/aaaa.
- Instalación en Android y carga sin conexión después de abrirla una vez en línea.

## Probar en Acode

1. En Android, descarga la carpeta o los archivos del repositorio de GitHub y ábrelos en Acode.
2. Abre `index.html` con la vista previa de Acode. Para instalar la app y habilitar el modo sin conexión, publícala por HTTPS en GitHub Pages.
3. Desde Acode puedes modificar `index.html`, `styles.css` y `app.js`; guarda y actualiza la vista previa.

## Publicar con GitHub Pages

1. Crea un repositorio nuevo en GitHub.
2. Sube todos los archivos de esta carpeta al nivel principal del repositorio.
3. En GitHub, abre **Settings → Pages**.
4. En **Build and deployment**, selecciona **Deploy from a branch**, elige la rama `main` y la carpeta `/(root)`, y guarda.
5. Espera a que GitHub muestre el enlace del sitio. Ábrelo en Chrome Android y usa **Instalar app** o el menú **Agregar a pantalla principal**.

## Respaldos y privacidad

Los datos se guardan localmente en el navegador y el dispositivo donde se introducen. GitHub Pages publica los archivos de la aplicación, pero no sincroniza registros entre dispositivos. En **Ajustes y respaldo**, descarga copias JSON con regularidad; en otro dispositivo, abre la misma sección y restaura el archivo. Puedes descargar la tabla como CSV para Excel o Google Sheets.

## Reglas de cálculo

La comisión total de un registro es `cantidad × comisión por unidad` del producto. Los abonos quedan guardados con fecha y nota, se pueden editar o eliminar desde el historial y no pueden exceder el saldo disponible. Se rechazan pagos con fecha futura y montos con más de dos decimales. El saldo pendiente es `comisión total − suma de abonos`. Editar un producto cambia la tarifa para registros nuevos; cada registro conserva su tarifa y total originales. Si editas la cantidad de un registro ya pagado, el nuevo total no puede quedar por debajo del dinero que ya se pagó. Los montos se presentan en MXN; importar un respaldo con importes de otra moneda no los convierte.
