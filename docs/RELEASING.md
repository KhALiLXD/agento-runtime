# نشر تحديثات AGENTO

هذا دليل Maintainer لنشر `agento-runtime` على npm من مستودع [AGENTO](https://github.com/KhALiLXD/agento-runtime). الأوامر أدناه مهيأة لـ PowerShell على Windows. نفّذ كل مرحلة بعد نجاح السابقة.

إعداد المستودع الحالي: `npm test` يبني الحزمة ثم يشغّل اختبارات V2، بما فيها OpenAPI. `npm run lint` يفحص TypeScript والتنسيق. `prepack` يعيد بناء `dist`، و`files: ["dist"]` يحدد ملفات التنفيذ المنشورة. CI يفحص Linux وWindows على Node 20 و22 و24، لكنه **لا ينشر الحزمة**. Git push وGitHub Release ونشر موقع التوثيق لا تنفّذ `npm publish`.

## 1. حدد النسخة وقناة النشر

افحص الحالة الفعلية قبل كل تحديث:

```powershell
git status --short
node --version
npm --version
node -p "require('./package.json').version"
npm view agento-runtime version dist-tags --json
npm view agento-runtime versions --json
```

يجب ألا يظهر تعديل محلي غير محفوظ. استخدم Node 20.11 أو أحدث؛ Node 24 مناسب للفحوص الحالية. إن لم يكن لديك checkout، استنسخ المستودع ثم نفّذ الأوامر من جذره.

بتاريخ 13 أكتوبر 2026 كانت `latest` تساوي `1.0.0`. مولّد OpenAPI موجود في PR #2 وغير منشور. الأرقام التالية أمثلة لعملية النشر، وليست إصدارات منشورة أو قرارًا اتُخذ تلقائيًا.

| نوع التغيير                            | مثال Version   | قناة npm                    |
| -------------------------------------- | -------------- | --------------------------- |
| إصلاح متوافق دون إضافة API             | `1.0.1`        | `latest`                    |
| إضافة متوافقة مثل مدخل OpenAPI المستقل | `1.1.0`        | `latest` بعد التحقق         |
| تجربة الإضافة قبل الإصدار المستقر      | `1.1.0-beta.1` | `beta`                      |
| Release candidate                      | `1.1.0-rc.1`   | `next`                      |
| تغيير يكسر التوافق                     | `2.0.0`        | `latest` بعد توثيق الانتقال |

للتحديث الحالي، `1.1.0-beta.1` خيار أول إذا أردت تجربة المستخدمين، و`1.1.0` مناسب بعد ثبوت التوافق. قيمة Config `version: "2"` لا تحدد رقم حزمة npm. شارات الموقع `New` و`Beta` و`Pre-release` أيضًا لا تحدد النسخة أو قناة npm.

## 2. جهّز release commit للمراجعة

ادمج تغيير الميزة بعد نجاح فحوص PR. بعدها اسحب `main` وافتح فرعًا لرقم النسخة. هذا المثال لإصدار مستقر؛ بدّل الرقم واسم الفرع عند اختيار إصدار تجريبي.

```powershell
git switch main
git pull --ff-only origin main
git switch -c release/1.1.0
npm version 1.1.0 --no-git-tag-version
git diff -- package.json package-lock.json
```

`npm version` يعدّل رقم النسخة في `package.json` و`package-lock.json`. خيار `--no-git-tag-version` يترك إنشاء commit وGit tag لك، حتى تُراجع نسخة النشر عبر PR قبل وضع علامة الإصدار. لإصدار Beta، استخدم بدل أمر النسخة أعلاه:

```powershell
npm version 1.1.0-beta.1 --no-git-tag-version
```

لا تنفّذ الأمرين لنفس الإصدار. تأكد أن الرقم المختار غير موجود في `npm view agento-runtime versions --json`؛ لا يمكن إعادة نشر نفس الاسم والنسخة.

## 3. افحص الكود ومحتوى الحزمة

```powershell
npm ci
npm run lint
npm test
npm ci --prefix examples/discord-bot
npm --prefix examples/discord-bot run typecheck
npm pack --dry-run
```

لا تتجاوز فشل أي أمر. راجع قائمة ملفات الحزمة. لتحديث OpenAPI يجب أن تتضمن:

- `package.json` وفيه export مستقل `./openapi` وbin باسم `agento-openapi`.
- `dist/v2/index.js` وملفات declarations الخاصة بالـ Runtime.
- `dist/openapi/index.js` و`dist/openapi/index.d.ts` و`dist/openapi/cli.js`.

يجب ألا تظهر أسرار أو ملفات بيئة أو Config فعلية للعملاء. `prepack` يبني `dist`؛ لا تحتاج إلى نشر مجلد `src` أو تشغيل المولّد داخل Runtime.

افحص حزمة فعلية بتثبيتها في مجلد منفصل. المثال التالي يفترض أن رقم النسخة المختار هو `1.1.0`؛ استخدم اسم `.tgz` الذي يطبعه `npm pack` لنسختك. استخدم مجلد smoke جديدًا لكل إصدار.

```powershell
New-Item -ItemType Directory -Force ../agento-release
npm pack --pack-destination ../agento-release
New-Item -ItemType Directory ../agento-release/smoke-1.1.0
Push-Location ../agento-release/smoke-1.1.0
npm init -y
npm install --save-exact ../agento-runtime-1.1.0.tgz
node --input-type=module -e "import { AgentRuntime } from 'agento-runtime'; import { generateConfig } from 'agento-runtime/openapi'; if (typeof AgentRuntime.create !== 'function' || typeof generateConfig !== 'function') process.exit(1); console.log('Package imports OK');"+npx --no-install agento-openapi --help
Pop-Location
```

انسخ `examples/openapi/catalog.json` من checkout إلى مجلد smoke، ثم شغّل داخله:

```powershell
npx --no-install agento-openapi catalog.json --output config.generated.yml
```

تحقق من نجاح التوليد وراجع YAML. ظهور `REVIEW_REQUIRED` على stderr متوقع. إعادة الأمر إلى نفس الملف يجب أن تفشل بـ `EEXIST` دون تغيير الملف. هذا اختبار للحزمة المحلية؛ لا ينشر شيئًا على npm.

## 4. احفظ نسخة النشر وادمجها

بعد نجاح الفحوص، ارجع إلى جذر المستودع، واحفظ رقم النسخة وأي release notes أعددتها:

```powershell
git add package.json package-lock.json
git commit -m "chore: prepare release 1.1.0"
git push -u origin release/1.1.0
```

افتح PR إلى `main`، انتظر نجاح CI، ثم ادمجه. اسحب `main` وافحصها مرة أخرى بالأوامر في المرحلة 3، بما فيها الحزمة الفعلية؛ قد يكون دخل تعديل آخر أثناء المراجعة. تحقق أن `package.json` يحمل الرقم المقصود وأن working tree نظيف. إن كانت هناك تغييرات إضافية غير مقصودة، لا تنشرها ضمن هذه النسخة.

## 5. سجّل الدخول وانشر من جذر المستودع

```powershell
git switch main
git pull --ff-only origin main
git status --short
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
node -p "require('./package.json').name + '@' + require('./package.json').version"
```

أكمل تسجيل الدخول في المتصفح بحساب له صلاحية نشر `agento-runtime`. أكمل تحقق 2FA عند طلبه. لا تضع رمزًا أو token في ملف المستودع. يجب أن تكون قد اختبرت **هذا commit نفسه** وفق المرحلتين 3 و4.

لإصدار مستقر فقط:

```powershell
npm publish --dry-run --access public --tag latest --registry=https://registry.npmjs.org
npm publish --access public --tag latest --registry=https://registry.npmjs.org
```

لإصدار Beta فقط، بدّل أوامر النشر إلى:

```powershell
npm publish --dry-run --access public --tag beta --registry=https://registry.npmjs.org
npm publish --access public --tag beta --registry=https://registry.npmjs.org
```

لـ `-rc.*` استخدم `--tag next`. اختر قناة واحدة مناسبة. نشر Beta على `beta` يبقي `latest` على النسخة المستقرة؛ يثبت المستخدم النسخة التجريبية عبر `npm install agento-runtime@beta`. `--dry-run` لا يرفع الحزمة، ولا يثبت أن صلاحيات حسابك تسمح بالنشر.

## 6. تحقق من النسخة المنشورة ثم أنشئ Git tag

استبدل `1.1.0` بالنسخة المنشورة فعلًا:

```powershell
npm view agento-runtime@1.1.0 version exports bin --json
npm view agento-runtime dist-tags --json
```

ثبّت `agento-runtime@1.1.0` من npm في مجلد smoke جديد وكرر فحص imports وCLI في المرحلة 3. استخدم النسخة الصريحة بدل `latest` أو `beta` في هذا الفحص، حتى تختبر النسخة التي نشرتها تحديدًا.

بعد نجاح التحقق، ضع Git tag على commit الذي نشرت منه:

```powershell
git tag -a v1.1.0 -m "AGENTO 1.1.0"
git push origin v1.1.0
```

أنشئ GitHub Release من هذه العلامة وأضف وصف التغيير وأوامر التثبيت. فعّل خيار Pre-release في GitHub للإصدارات مثل `1.1.0-beta.1` و`1.1.0-rc.1`. Git tag وGitHub Release يوثقان المصدر، ولا ينشران npm في إعداد CI الحالي.

للانتقال من `1.1.0-beta.1` إلى `1.1.0`، كرر العملية مع **رقم مستقر جديد**. نقل dist-tag لنسخة ذات suffix `-beta.*` لا يحوّلها إلى نسخة مستقرة.

## 7. حدّث موقع التوثيق

في مستودع [docu-flow-arabic-english](https://github.com/KhALiLXD/docu-flow-arabic-english):

1. عدّل `library_version` و`library_status` في `src/content/agento/manifest.json` وفق النسخة التي يوثقها الموقع. إذا بقي الموقع يوثق المستقر مع صفحة خاصة بـ Beta، فلا تغيّر حالة الموقع كله إلى Beta.
2. عدّل توفر صفحات OpenAPI وcommit المصدر إلى حالة الإصدار الفعلية. عند نشر الميزة على npm، استخدم `availability: "released"` لنسخة متاحة، ثم وضّح إن كانت متاحة على `beta` فقط.
3. عدّل فقرة توفر الميزة وأوامر التثبيت بالعربية والإنجليزية. احذف عبارة «التحديث القادم» عندما تصبح غير صحيحة.
4. اضبط `options.tags`: ميزة مستقرة جديدة تستخدم `new: true` و`beta: false` و`pre-release: false`. ميزة Beta يمكن أن تستخدم الثلاثة حسب السياق. الشارات اختيارية ولا تغير توفر الحزمة.
5. حدّث assertions الخاصة بحالة OpenAPI في `scripts/check-docs.mjs`؛ الفحص الحالي يتوقع `unreleased` قبل النشر. راجع أمثلة التنزيل والمراجع المحمولة وأي أرقام نسخة أخرى تتغير.

```powershell
npm ci
npm run docs:kit
npm run docs:check
npx tsc --noEmit
npm run build
```

احفظ التغيير في PR، تحقق من Vercel Preview، ثم ادمج إلى فرع النشر وتحقق من Production. نجاح Preview لفرع PR لا يعني أن الموقع الأساسي تحدّث. إذا حظر Vercel dependency بسبب ثغرة، حدّث النسخة المصححة وملفَي `package-lock.json` و`bun.lock` ثم أعد النشر.

## إذا فشل النشر أو اكتشفت خطأ بعده

| المشكلة                                  | الإجراء                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| الرقم منشور مسبقًا / `EPUBLISHCONFLICT`  | افحص النسخ، واختر رقمًا جديدًا، ثم أعد الفحوص.                                                 |
| صلاحيات أو تسجيل دخول / `E401` أو `E403` | تحقق من `npm whoami`، وصلاحيات الحساب، و2FA. لا تغيّر اسم الحزمة لتجاوز المشكلة.               |
| فشل اختبار أو ملف مفقود في tarball       | أصلح المصدر أو إعداد التغليف، ثم أعد الاختبارات و`npm pack`.                                   |
| انقطاع أثناء `npm publish`               | افحص `npm view agento-runtime@VERSION version` قبل إعادة المحاولة؛ قد تكون النسخة وصلت بالفعل. |
| خطأ في نسخة وصلت إلى npm                 | لا يمكن استبدال محتواها بنفس الرقم. انشر إصلاحًا برقم جديد.                                    |

إذا احتجت إرجاع التثبيت الافتراضي إلى نسخة سابقة، فالأوامر التالية مثال، وليست جزءًا من النشر المعتاد:

```powershell
npm dist-tag add agento-runtime@1.0.0 latest
npm deprecate agento-runtime@1.1.0 "Known regression; use 1.0.0 until a fixed release is available."
```

اختر النسخة السابقة المثبتة سلامتها، وغيّر رسالة الإهمال لتصف المشكلة والحل. تغيير `latest` لا يغيّر النسخة لدى من ثبّتها بالفعل أو ثبّت رقمًا صريحًا. بعد نشر الإصلاح، تحقق من dist-tags والتوثيق مجددًا.

## تذكير سريع

رقم جديد → فحوص وtarball → PR نسخة النشر وCI → نفس commit على `main` → تسجيل دخول → `npm publish` بالقناة الصحيحة → تحقق من npm → Git tag وGitHub Release → تحديث التوثيق والتحقق من Production.

## المراجع

- [npm publish](https://docs.npmjs.com/cli/v12/commands/npm-publish/)
- [npm version](https://docs.npmjs.com/cli/v12/commands/npm-version/)
- [npm dist-tag](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/)
- [متطلبات 2FA للنشر](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)

آخر مراجعة لهذا الدليل: 13 أكتوبر 2026. افحص إعدادات المستودع وحالة npm عند كل إصدار.
