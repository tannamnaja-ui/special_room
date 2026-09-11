using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;

class IconGen
{
    static Bitmap DrawFrame(int size)
    {
        var bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Color.Transparent);

            float pad = size * 0.04f;
            var rect = new RectangleF(pad, pad, size - pad * 2, size - pad * 2);

            // พาสเทลชมพู วงกลม พร้อมไล่เฉดอ่อนๆ ให้ดูมีมิติ
            using (var path = new GraphicsPath())
            {
                path.AddEllipse(rect);
                using (var brush = new PathGradientBrush(path))
                {
                    brush.CenterColor = ColorTranslator.FromHtml("#FFD6E8");
                    brush.SurroundColors = new[] { ColorTranslator.FromHtml("#F5A9C9") };
                    g.FillPath(brush, path);
                }
            }

            // ขอบวงกลมสีชมพูเข้มขึ้นเล็กน้อย
            using (var pen = new Pen(ColorTranslator.FromHtml("#E884B3"), Math.Max(1f, size * 0.02f)))
            {
                g.DrawEllipse(pen, rect);
            }

            // คำว่า Room สีขาว กึ่งกลางวงกลม — ย่อ/ขยายฟอนต์ให้พอดีความกว้างด้านในวงกลมเสมอ
            // (ไอคอนมีหลายขนาดตั้งแต่ 16px ถึง 256px ถ้า fix ขนาดฟอนต์ไว้ ตัวอักษรจะล้นในขนาดเล็ก)
            const string text = "Room";
            float maxWidth = size * 0.74f;   // ความกว้างที่ยอมให้ข้อความกินภายในวงกลม
            using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var textBrush = new SolidBrush(Color.White))
            {
                float fontSize = size * 0.30f;
                for (int i = 0; i < 24; i++)
                {
                    using (var probe = new Font("Segoe UI", fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                    {
                        var sz = g.MeasureString(text, probe);
                        if (sz.Width <= maxWidth) break;
                        fontSize *= maxWidth / sz.Width;
                    }
                }
                using (var font = new Font("Segoe UI", fontSize, FontStyle.Bold, GraphicsUnit.Pixel))
                {
                    var textRect = new RectangleF(0, size * -0.02f, size, size);
                    g.DrawString(text, font, textBrush, textRect, fmt);
                }
            }
        }
        return bmp;
    }

    static byte[] ToPngBytes(Bitmap bmp)
    {
        using (var ms = new MemoryStream())
        {
            bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            return ms.ToArray();
        }
    }

    static void Main(string[] args)
    {
        string outPath = args.Length > 0 ? args[0] : "icon.ico";
        int[] sizes = { 16, 32, 48, 64, 128, 256 };
        var pngs = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
        {
            using (var bmp = DrawFrame(sizes[i]))
            {
                pngs[i] = ToPngBytes(bmp);
            }
        }

        using (var fs = new FileStream(outPath, FileMode.Create, FileAccess.Write))
        using (var bw = new BinaryWriter(fs))
        {
            // ICONDIR
            bw.Write((short)0);      // reserved
            bw.Write((short)1);      // type = icon
            bw.Write((short)sizes.Length);

            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                int s = sizes[i] >= 256 ? 0 : sizes[i]; // 0 = 256 in ICO format
                bw.Write((byte)s);
                bw.Write((byte)s);
                bw.Write((byte)0);   // color count
                bw.Write((byte)0);   // reserved
                bw.Write((short)1);  // planes
                bw.Write((short)32); // bit count
                bw.Write((int)pngs[i].Length);
                bw.Write((int)offset);
                offset += pngs[i].Length;
            }
            for (int i = 0; i < sizes.Length; i++)
            {
                bw.Write(pngs[i]);
            }
        }

        Console.WriteLine("Icon written: " + outPath);

        // อาร์กิวเมนต์ที่สอง = เขียนไฟล์ PNG ไว้ดูหน้าตาไอคอน (ICO ที่ฝังเฟรมแบบ PNG
        // เปิดดูตรง ๆ ด้วย System.Drawing.Icon ไม่ได้ทุกขนาด)
        if (args.Length > 1)
        {
            using (var bmp = DrawFrame(256))
                bmp.Save(args[1], System.Drawing.Imaging.ImageFormat.Png);
            Console.WriteLine("Preview written: " + args[1]);
        }
    }
}
