const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://kdxcxosppuzudpuxaeac.supabase.co';
const supabaseKey = 'sb_publishable_RNxqswxz9c-6SJ3EPmaHpg_DYAlFW5S';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;