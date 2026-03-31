const UrlHelper = require('./app/utils/url');
process.env.MEDIA_DROP_HTTP_BASE_URL = 'https://yt.finchwire.site';

console.log('--- URL Helper Test ---');
const filename = 'Ancient_Craft.mp4';
const mediaUrl = UrlHelper.buildMediaUrl(filename);
const vlcUrl = UrlHelper.buildVlcUrl(filename);

console.log('Filename:', filename);
console.log('Media URL:', mediaUrl);
console.log('VLC URL:', vlcUrl);

if (mediaUrl === 'https://yt.finchwire.site/media/Ancient_Craft.mp4') {
    console.log('✅ Media URL Correct');
} else {
    console.log('❌ Media URL Malformed:', mediaUrl);
}

if (vlcUrl === 'vlc://https://yt.finchwire.site/media/Ancient_Craft.mp4') {
    console.log('✅ VLC URL Correct');
} else {
    console.log('❌ VLC URL Malformed:', vlcUrl);
}
